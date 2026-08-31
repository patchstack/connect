// Rule source: pick where the ruleset comes from — an explicit bundle, or the live API by site
// UUID (Pulse) or token — fetch it (conditional/If-None-Match via the persisted etag), and fall
// back through last-known-good → bundled → empty. Fail-open: a fetch/parse error never throws.
// The `store` (see ./store.js) is passed in so a refresh reuses the same tiered cache.
//
// Every returned bundle carries `source: { ok, reason? }` — whether the RULES came from the source or
// from a fallback. Absorbing a failure into usable rules is right for protection and insufficient for a
// caller that has its own decision to make: a poller reading only thrown errors treats an outage as a
// healthy poll. The rules answer "what do I enforce"; `source` answers "are these current".
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

export async function resolveRules(options, store, ctx = {}) {
  // The INITIAL load is on the app's startup path, so the runtime gives it a short budget (see
  // bootTimeoutMs) and falls back to cache/bundled rather than delaying boot; refreshes get the full
  // budget. A timeout here is not a protection gap by itself — last-known-good still applies.
  const timeoutMs = ctx.timeoutMs;
  if (options.siteUuid) {
    const prior = await store.read(); // { bundle, etag } | null
    const client = new PulseRuleClient({ siteUuid: options.siteUuid, baseUrl: options.pulseRulesUrl, etag: prior?.etag, timeoutMs, pulseAuth: ctx.pulseAuth, reportsDetections: options.reportDetections === true });
    const res = await client.getRules();
    if (res.success && res.notModified && prior?.bundle) return fromSource(normalizeBundle(prior.bundle, options), 'cache');
    if (res.success && !res.notModified) {
      const rejected = liveUpdateRejections(res, options);
      if (rejected.length > 0) {
        reportRejections(rejected, options, 'rule update rejected');
        // Reached the source and refused what it sent. Not ok: the running rules are not the delivered
        // ones, and asking again at the normal interval re-downloads the same rejected bundle.
        if (prior?.bundle) return fromSource(normalizeBundle(prior.bundle, options), 'cache', 'update rejected');
        if (options.rules) return fromSource(normalizeBundle(options.rules, options), 'bundled', 'update rejected');
        return fromSource(emptyBundle(), 'empty', 'update rejected');
      }
      const bundle = normalizeBundle(res, options);
      await store.write({ bundle, etag: res.etag ?? null });
      return fromSource(bundle, 'api');
    }
    if (prior?.bundle) {
      notify(options.onError, new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); using cached bundle`), 'onError');
      return fromSource(normalizeBundle(prior.bundle, options), 'cache', res.error ?? 'no usable response');
    }
    if (options.rules) {
      notify(options.onError, new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); using bundled fallback`), 'onError');
      return fromSource(normalizeBundle(options.rules, options), 'bundled', res.error ?? 'no usable response');
    }
    notify(options.onError, new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); no cache — running with no rules`), 'onError');
    return fromSource(emptyBundle(), 'empty', res.error ?? 'no usable response');
  }

  if (options.token) {
    const prior = await store.read();
    const client = new PatchstackRuleClient({ token: options.token, baseUrl: options.baseUrl, etag: prior?.etag, timeoutMs });
    const res = await client.getRules();
    if (res.success && res.notModified && prior?.bundle) return fromSource(normalizeBundle(prior.bundle, options), 'cache');
    if (res.success && !res.notModified) {
      const rejected = liveUpdateRejections(res, options);
      if (rejected.length > 0) {
        reportRejections(rejected, options, 'rule update rejected');
        // Reached the source and refused what it sent. Not ok: the running rules are not the delivered
        // ones, and asking again at the normal interval re-downloads the same rejected bundle.
        if (prior?.bundle) return fromSource(normalizeBundle(prior.bundle, options), 'cache', 'update rejected');
        if (options.rules) return fromSource(normalizeBundle(options.rules, options), 'bundled', 'update rejected');
        return fromSource(emptyBundle(), 'empty', 'update rejected');
      }
      const bundle = normalizeBundle(res, options);
      await store.write({ bundle, etag: res.etag ?? null });
      return fromSource(bundle, 'api');
    }
    if (prior?.bundle) {
      notify(options.onError, new Error(`rule fetch failed (${res.error ?? 'no usable response'}); using cached bundle`), 'onError');
      return fromSource(normalizeBundle(prior.bundle, options), 'cache', res.error ?? 'no usable response');
    }
    notify(options.onError, new Error(`rule fetch failed (${res.error ?? 'no usable response'}); no cache — running with no rules`), 'onError');
    return fromSource(emptyBundle(), 'empty', res.error ?? 'no usable response');
  }

  // No live source configured, so the bundle IS the source and cannot be behind one.
  if (options.rules) {
    return fromSource(normalizeBundle(options.rules, options), 'bundled');
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
