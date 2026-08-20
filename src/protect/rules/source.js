// Rule source: pick where the ruleset comes from — an explicit bundle, or the live API by site
// UUID (Pulse) or token — fetch it (conditional/If-None-Match via the persisted etag), and fall
// back through last-known-good → bundled → empty. Fail-open: a fetch/parse error never throws.
// The `store` (see ./store.js) is passed in so a refresh reuses the same tiered cache.
import { PatchstackRuleClient } from '../engine/index.js';
import { PulseRuleClient } from '../engine/pulse-client.js';
import { validateBundle } from './validate.js';

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
      try { report({ ...r, accepted: false }); } catch { /* reporting must never break rule loading */ }
    }
  }
  const sample = rejected.slice(0, 3).map((r) => `${r.id} (${r.reason})`).join('; ');
  options.onError?.(new Error(
    `${label}: rejected the entire update because ${rejected.length} rule(s) failed validation — ` +
    `keeping the previous ruleset and NOT caching this response: ${sample}${rejected.length > 3 ? ', …' : ''}`,
  ));
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
    if (res.success && res.notModified && prior?.bundle) return normalizeBundle(prior.bundle, options);
    if (res.success && !res.notModified) {
      const rejected = liveUpdateRejections(res, options);
      if (rejected.length > 0) {
        reportRejections(rejected, options, 'rule update rejected');
        if (prior?.bundle) return normalizeBundle(prior.bundle, options);
        if (options.rules) return normalizeBundle(options.rules, options);
        return emptyBundle();
      }
      const bundle = normalizeBundle(res, options);
      await store.write({ bundle, etag: res.etag ?? null });
      return bundle;
    }
    if (prior?.bundle) {
      options.onError?.(new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); using cached bundle`));
      return normalizeBundle(prior.bundle, options);
    }
    if (options.rules) {
      options.onError?.(new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); using bundled fallback`));
      return normalizeBundle(options.rules, options);
    }
    options.onError?.(new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); no cache — running with no rules`));
    return emptyBundle();
  }

  if (options.token) {
    const prior = await store.read();
    const client = new PatchstackRuleClient({ token: options.token, baseUrl: options.baseUrl, etag: prior?.etag, timeoutMs });
    const res = await client.getRules();
    if (res.success && res.notModified && prior?.bundle) return normalizeBundle(prior.bundle, options);
    if (res.success && !res.notModified) {
      const rejected = liveUpdateRejections(res, options);
      if (rejected.length > 0) {
        reportRejections(rejected, options, 'rule update rejected');
        if (prior?.bundle) return normalizeBundle(prior.bundle, options);
        if (options.rules) return normalizeBundle(options.rules, options);
        return emptyBundle();
      }
      const bundle = normalizeBundle(res, options);
      await store.write({ bundle, etag: res.etag ?? null });
      return bundle;
    }
    if (prior?.bundle) {
      options.onError?.(new Error(`rule fetch failed (${res.error ?? 'no usable response'}); using cached bundle`));
      return normalizeBundle(prior.bundle, options);
    }
    options.onError?.(new Error(`rule fetch failed (${res.error ?? 'no usable response'}); no cache — running with no rules`));
    return emptyBundle();
  }

  if (options.rules) {
    return normalizeBundle(options.rules, options);
  }

  return emptyBundle();
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
        try { report(r); } catch { /* reporting must never break rule loading */ }
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
