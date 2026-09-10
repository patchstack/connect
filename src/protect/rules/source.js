// Rule source: pick where the ruleset comes from — an explicit bundle, or the live API by site
// UUID (Pulse) or token — fetch it (conditional/If-None-Match via the persisted etag), and fall
// back through last-known-good → bundled → empty. Fail-open: a fetch/parse error never throws.
// The `store` (see ./store.js) is passed in so a refresh reuses the same tiered cache.
//
// Every returned bundle carries `source: { ok, reason? }` — whether the RULES came from the source or
// from a fallback. Absorbing a failure into usable rules is right for protection and insufficient for a
// caller that has its own decision to make: a poller reading only thrown errors treats an outage as a
// healthy poll. The rules answer "what do I enforce"; `source` answers "are these current".
import { canonicalBuildId, readBuildStamp } from '../../build-id.js';
import { BUILD_SCOPE_PROPERTY } from './contract.js';
import { PatchstackRuleClient } from '../engine/index.js';
import { PulseRuleClient } from '../engine/pulse-client.js';
import { validateBundle } from './validate.js';
import { notify } from '../notify.js';

// A LIVE update is accepted ATOMICALLY. Dropping individual invalid rules is fine for a bundle we
// already trust (a cache entry, a bundled fallback), but for a fresh remote response it would let a
// broken update REPLACE known-good policy with partial or empty policy — turning "we validated it" into
// a loss of protection, and caching that loss. So: if any rule/whitelist fails validation, reject the
// whole update, keep last-known-good, report it, and do NOT write the cache. Opt in to the old
// behaviour with `acceptPartialBundle: true` (metrics still report every drop).
function liveUpdateRejections(res, options) {
  if (options.acceptPartialBundle) return [];
  const { rejected } = validateBundle(
    { firewall: Array.isArray(res.firewall) ? res.firewall : [], whitelists: Array.isArray(res.whitelists) ? res.whitelists : [] },
    { allowGlobalWhitelists: options.allowGlobalWhitelists },
  );
  return rejected;
}

function reportRejections(rejected, options, label) {
  const report = options.onRuleRejected;
  for (const r of rejected) {
    if (typeof report === 'function') {
      notify(report, { ...r, accepted: false }, 'onRuleRejected');
    }
  }
  const sample = rejected.slice(0, 3).map((r) => `${r.id} (${r.reason})`).join('; ');
  notify(options.onError, new Error(
    `${label}: rejected the entire update because ${rejected.length} rule(s) failed validation — ` +
    `keeping the previous ruleset and NOT caching this response: ${sample}${rejected.length > 3 ? ', …' : ''}`,
  ), 'onError');
}

/** A bundle plus the outcome of the attempt that produced it. `source` is never written to the store. */
/**
 * Wrap a resolved bundle with where it came from and whether the resolution was clean.
 *
 * `origin` is separate from `ok` because they answer different questions and a caller needs both.
 * `ok: false` says the resolution hit a problem; `origin` says which leg actually supplied the rules
 * that are now running:
 *
 *   `api`      delivered by the platform on this call
 *   `cache`    last-known-good from the store — still platform-delivered, just not on this call
 *   `bundled`  the caller's own `rules` option, which the platform never saw
 *   `empty`    nothing at all
 *
 * Detection reporting depends on this distinction. Reporting is for sites the platform manages, so a
 * guard running bundled or empty rules has nothing to report against: the platform has no rule document
 * to attribute a hit to, and a detection naming a rule id it never issued is not evidence of anything.
 *
 * @param {object} bundle
 * @param {'api'|'cache'|'bundled'|'empty'} origin
 * @param {string} [reason]
 */
function fromSource(bundle, origin, reason) {
  return {
    ...bundle,
    source: reason === undefined ? { ok: true, origin } : { ok: false, origin, reason },
  };
}

/**
 * Which mapped coordinate document this guard carries, or why it cannot say.
 *
 * Read from the stamp in the bundled rules the guard shipped with, or from an explicit `buildId` for a
 * consumer wiring `createProtection` by hand. Never from the API response: the response is what the
 * identity is presented TO, and a value taken from it would let a refresh change which map the
 * guard claims to be.
 *
 * The reason matters as much as the value: a guard with no identity keeps running every ordinary rule,
 * and the reason is what gets reported when build-scoped rules are held back.
 */
function buildIdentity(options) {
  if (options.buildId !== undefined && options.buildId !== null) {
    const explicit = canonicalBuildId(options.buildId);

    return explicit === null
      ? { id: null, reason: 'the buildId option is not a complete 64-hex SHA-256 identity' }
      : { id: explicit };
  }
  const stamped = readBuildStamp(options.rules);
  if (stamped !== null) return { id: stamped };

  return {
    id: null,
    reason: options.rules
      ? 'the guard rules file carries no build identity — the build did not stamp one'
      : 'this guard was configured without bundled rules, so it carries no build identity',
  };
}

/**
 * Hold build-scoped rules in dry-run, and say so once.
 *
 * A scoped rule carries `build_scope`: the mapped document containing its coordinate — a route and a
 * field name. The rule may only enforce when the guard carries that map identity, confirmed by the
 * platform rather than assumed here.
 *
 * `build_scope`, never `source_revision`. That field is the revision of any served rule document —
 * numeric for a generated rule, a hash for a curated one — and reading it as a scoping marker would
 * hold ordinary versioned rules in dry-run, losing protection that never depended on a coordinate.
 *
 * A malformed `build_scope` is treated as scoped-and-unmatchable rather than as absent: a value nothing
 * can compare is not permission.
 *
 * Narrowing only. `enforcement: 'dry-run'` is the single value a rule may take to detect without
 * blocking, so this can never turn a dry-run rule into a blocking one, and every rule without a
 * `build_scope` is untouched.
 *
 * @param {object} bundle
 * @param {string|null} confirmed the map the platform confirmed, or null when nothing did
 * @param {string} reason why nothing was confirmed, for the notice
 * @param {object} options
 */
export function withScopedDryRun(bundle, confirmed, reason, options = {}) {
  let held = 0;
  let unusable = 0;
  const firewall = bundle.firewall.map((rule) => {
    if (rule === null || typeof rule !== 'object') return rule;
    if (!(BUILD_SCOPE_PROPERTY in rule)) return rule; // not scoped to a build at all
    const scope = rule[BUILD_SCOPE_PROPERTY];
    const target = canonicalBuildId(scope);
    if (target !== null && confirmed !== null && target === confirmed) return rule; // confirmed for us
    if (rule.enforcement === 'dry-run') return rule;
    held += 1;
    if (target === null) unusable += 1;

    return { ...rule, enforcement: 'dry-run' };
  });
  if (held === 0) return bundle;
  const explanations = [
    ...(unusable > 0 ? [`${unusable} rule(s) carry an unusable ${BUILD_SCOPE_PROPERTY}`] : []),
    ...(held > unusable ? [reason] : []),
  ];
  notify(
    options.onError,
    new Error(`${held} build-scoped rule(s) are detecting only, not blocking: ${explanations.join('; ')}`),
    'onError',
  );

  return { ...bundle, firewall };
}

/**
 * What the platform confirmed about a response, if anything.
 *
 * A verdict is only permission when it says `match` AND names the map that was presented. A bare
 * `match`, a match naming something else, an unknown word and an absent field all confirm nothing —
 * which is what lets this client ship before the endpoint implements the verdict without appearing to
 * corroborate every build in the meantime.
 */
function confirmedBy(res, presented) {
  if (presented === null) return null;
  const verdict = res?.build;
  if (verdict?.verdict !== 'match') return null;

  return canonicalBuildId(verdict.matchedBuildId) === presented ? presented : null;
}

export async function resolveRules(options, store, ctx = {}) {
  // The INITIAL load is on the app's startup path, so the runtime gives it a short budget (see
  // bootTimeoutMs) and falls back to cache/bundled rather than delaying boot; refreshes get the full
  // budget. A timeout here is not a protection gap by itself — last-known-good still applies.
  const timeoutMs = ctx.timeoutMs;
  if (options.siteUuid) {
    const prior = await store.read(); // { bundle, etag, buildId, matchedBuildId } | null
    const identity = buildIdentity(options);

    // Whether the cache was fetched for this same map. Governs the CONDITIONAL REQUEST only:
    // revalidating against another map's ETag would return 304 and hand that map's bundle
    // back as current. Two unidentified contexts count as the same one — that is every guard built
    // before stamping existed, and withholding revalidation from them would cost a full download per
    // refresh while changing nothing about what may enforce.
    const sameBuild = prior?.buildId === identity.id;

    // What the PLATFORM already confirmed for this same map, which is a different question and the
    // only one that licenses a build-scoped rule. Null for a cache from another map, a cache written
    // before verdicts existed, and a guard with no identity to confirm.
    const cacheConfirmed =
      identity.id !== null && sameBuild && prior?.matchedBuildId === identity.id ? identity.id : null;
    const unconfirmed =
      identity.reason ?? 'the platform did not confirm that these coordinates belong to this map';

    const served = (bundle, confirmed) => withScopedDryRun(bundle, confirmed, unconfirmed, options);
    // Rules the CALLER supplied. Not trusted by provenance — a locally supplied bundle can hold a
    // generated coordinate from an older map just as easily as a served one can. It enforces on its own
    // terms only when the rule names this very map, or when the caller takes responsibility with
    // `trustLocalRuleScope`.
    const local = (bundle) =>
      options.trustLocalRuleScope === true
        ? bundle
        : withScopedDryRun(bundle, identity.id, identity.reason ?? 'these rules name a different map', options);

    const client = new PulseRuleClient({
      siteUuid: options.siteUuid,
      baseUrl: options.pulseRulesUrl,
      etag: sameBuild ? prior?.etag : null,
      timeoutMs,
      pulseAuth: ctx.pulseAuth,
      detectionState: ctx.detectionState,
      buildId: identity.id,
    });
    const res = await client.getRules();
    if (res.success && res.notModified && prior?.bundle) {
      // The bundle is unchanged, but corroboration is request-specific and therefore refreshed even on
      // a 304. Persisting the new answer prevents a prior match surviving after the recorded map moves.
      const confirmed = confirmedBy(res, identity.id);
      await store.write({
        bundle: prior.bundle,
        etag: res.etag ?? prior.etag ?? null,
        buildId: identity.id,
        matchedBuildId: confirmed,
      });
      return fromSource(served(normalizeBundle(prior.bundle, options), confirmed), 'cache');
    }
    if (res.success && !res.notModified) {
      const confirmed = confirmedBy(res, identity.id);
      const rejected = liveUpdateRejections(res, options);
      if (rejected.length > 0) {
        reportRejections(rejected, options, 'rule update rejected');
        // Reached the source and refused what it sent. Not ok: the running rules are not the delivered
        // ones, and asking again at the normal interval re-downloads the same rejected bundle.
        if (prior?.bundle) return fromSource(served(normalizeBundle(prior.bundle, options), cacheConfirmed), 'cache', 'update rejected');
        if (options.rules) return fromSource(local(normalizeBundle(options.rules, options)), 'bundled', 'update rejected');
        return fromSource(emptyBundle(), 'empty', 'update rejected');
      }
      const bundle = normalizeBundle(res, options);
      // The verdict is stored, not the claim: `matchedBuildId` is what the platform confirmed, so a
      // later run cannot read this cache as a corroboration the platform never gave.
      await store.write({ bundle, etag: res.etag ?? null, buildId: identity.id, matchedBuildId: confirmed });
      return fromSource(served(bundle, confirmed), 'api');
    }
    if (prior?.bundle) {
      notify(options.onError, new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); using cached bundle`), 'onError');
      return fromSource(served(normalizeBundle(prior.bundle, options), cacheConfirmed), 'cache', res.error ?? 'no usable response');
    }
    if (options.rules) {
      notify(options.onError, new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); using bundled fallback`), 'onError');
      return fromSource(local(normalizeBundle(options.rules, options)), 'bundled', res.error ?? 'no usable response');
    }
    notify(options.onError, new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); no cache — running with no rules`), 'onError');
    return fromSource(emptyBundle(), 'empty', res.error ?? 'no usable response');
  }

  if (options.token) {
    // This source has no build-corroboration response. A scoped rule received through it therefore has
    // no permission to block; ordinary rules are unchanged. Locally supplied fallbacks can still prove
    // their own scope against the stamp they carry, or be explicitly trusted by the caller.
    const identity = buildIdentity(options);
    const remote = (bundle) =>
      withScopedDryRun(
        bundle,
        null,
        'the token-authenticated rules service did not corroborate this map',
        options,
      );
    const local = (bundle) =>
      options.trustLocalRuleScope === true
        ? bundle
        : withScopedDryRun(bundle, identity.id, identity.reason ?? 'these rules name a different map', options);
    const prior = await store.read();
    const client = new PatchstackRuleClient({ token: options.token, baseUrl: options.baseUrl, etag: prior?.etag, timeoutMs });
    const res = await client.getRules();
    if (res.success && res.notModified && prior?.bundle) {
      return fromSource(remote(normalizeBundle(prior.bundle, options)), 'cache');
    }
    if (res.success && !res.notModified) {
      const rejected = liveUpdateRejections(res, options);
      if (rejected.length > 0) {
        reportRejections(rejected, options, 'rule update rejected');
        // Reached the source and refused what it sent. Not ok: the running rules are not the delivered
        // ones, and asking again at the normal interval re-downloads the same rejected bundle.
        if (prior?.bundle) return fromSource(remote(normalizeBundle(prior.bundle, options)), 'cache', 'update rejected');
        if (options.rules) return fromSource(local(normalizeBundle(options.rules, options)), 'bundled', 'update rejected');
        return fromSource(emptyBundle(), 'empty', 'update rejected');
      }
      const bundle = normalizeBundle(res, options);
      await store.write({ bundle, etag: res.etag ?? null });
      return fromSource(remote(bundle), 'api');
    }
    if (prior?.bundle) {
      notify(options.onError, new Error(`rule fetch failed (${res.error ?? 'no usable response'}); using cached bundle`), 'onError');
      return fromSource(remote(normalizeBundle(prior.bundle, options)), 'cache', res.error ?? 'no usable response');
    }
    notify(options.onError, new Error(`rule fetch failed (${res.error ?? 'no usable response'}); no cache — running with no rules`), 'onError');
    return fromSource(emptyBundle(), 'empty', res.error ?? 'no usable response');
  }
  // No live source configured, so the bundle IS the source and cannot be behind one. That says nothing
  // about whether a coordinate in it still describes the running source: supplying a rule locally
  // establishes intent, not freshness. A build-scoped rule here enforces only when it names this very
  // map, or when the caller has taken responsibility with `trustLocalRuleScope`.
  if (options.rules) {
    const identity = buildIdentity(options);
    const bundle = normalizeBundle(options.rules, options);
    if (options.trustLocalRuleScope === true) return fromSource(bundle, 'bundled');

    return fromSource(
      withScopedDryRun(bundle, identity.id, identity.reason ?? 'these rules name a different map', options),
      'bundled',
    );
  }

  return fromSource(emptyBundle(), 'empty');
}

// Every rule path (live fetch, cache, bundled fallback) funnels through here, so this is where the
// delivered policy is VALIDATED before the engine ever executes it: bounded rule count / conditions /
// nesting / pattern length, known phases + actions. A rule that fails is dropped with a reported reason
// (`onRuleRejected`) rather than silently kept — an unenforceable rule must never look enforced.
export function normalizeBundle(b, options = {}) {
  const enforcement = b?.enforcement ?? b?.mode;
  const { bundle: checked, rejected } = validateBundle(
    {
      firewall: Array.isArray(b.firewall) ? b.firewall : [],
      whitelists: Array.isArray(b.whitelists) ? b.whitelists : [],
    },
    { allowGlobalWhitelists: options.allowGlobalWhitelists },
  );
  if (rejected.length > 0) {
    const report = options.onRuleRejected;
    if (typeof report === 'function') {
      for (const r of rejected) {
        notify(report, r, 'onRuleRejected');
      }
    } else {
      const sample = rejected.slice(0, 3).map((r) => `${r.id} (${r.reason})`).join('; ');
      // eslint-disable-next-line no-console
      console.warn(
        `[patchstack] ${rejected.length} delivered rule(s) rejected as invalid/oversized and are NOT enforced: ${sample}` +
          (rejected.length > 3 ? ', …' : ''),
      );
    }
  }
  return {
    firewall: checked.firewall,
    whitelists: checked.whitelists,
    whitelist_keys: b.whitelist_keys ?? {},
    ...(enforcement === 'block' || enforcement === 'dry-run' ? { enforcement } : {}),
  };
}

export function emptyBundle() {
  return { firewall: [], whitelists: [], whitelist_keys: {} };
}
