// Rule source: pick where the ruleset comes from — an explicit bundle, or the live API by site
// UUID (Pulse) or token — fetch it (conditional/If-None-Match via the persisted etag), and fall
// back through last-known-good → bundled → empty. Fail-open: a fetch/parse error never throws.
// The `store` (see ./store.js) is passed in so a refresh reuses the same tiered cache.
import { PatchstackRuleClient } from '../engine/index.js';
import { PulseRuleClient } from '../engine/pulse-client.js';

export async function resolveRules(options, store, ctx = {}) {
  // The INITIAL load is on the app's startup path, so the runtime gives it a short budget (see
  // bootTimeoutMs) and falls back to cache/bundled rather than delaying boot; refreshes get the full
  // budget. A timeout here is not a protection gap by itself — last-known-good still applies.
  const timeoutMs = ctx.timeoutMs;
  if (options.siteUuid) {
    const prior = await store.read(); // { bundle, etag } | null
    const client = new PulseRuleClient({ siteUuid: options.siteUuid, baseUrl: options.pulseRulesUrl, etag: prior?.etag, timeoutMs });
    const res = await client.getRules();
    if (res.success && res.notModified && prior?.bundle) return normalizeBundle(prior.bundle);
    if (res.success && !res.notModified) {
      const bundle = normalizeBundle(res);
      await store.write({ bundle, etag: res.etag ?? null });
      return bundle;
    }
    if (prior?.bundle) {
      options.onError?.(new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); using cached bundle`));
      return normalizeBundle(prior.bundle);
    }
    if (options.rules) {
      options.onError?.(new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); using bundled fallback`));
      return normalizeBundle(options.rules);
    }
    options.onError?.(new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); no cache — running with no rules`));
    return emptyBundle();
  }

  if (options.token) {
    const prior = await store.read();
    const client = new PatchstackRuleClient({ token: options.token, baseUrl: options.baseUrl, etag: prior?.etag, timeoutMs });
    const res = await client.getRules();
    if (res.success && res.notModified && prior?.bundle) return normalizeBundle(prior.bundle);
    if (res.success && !res.notModified) {
      const bundle = normalizeBundle(res);
      await store.write({ bundle, etag: res.etag ?? null });
      return bundle;
    }
    if (prior?.bundle) {
      options.onError?.(new Error(`rule fetch failed (${res.error ?? 'no usable response'}); using cached bundle`));
      return normalizeBundle(prior.bundle);
    }
    options.onError?.(new Error(`rule fetch failed (${res.error ?? 'no usable response'}); no cache — running with no rules`));
    return emptyBundle();
  }

  if (options.rules) {
    return normalizeBundle(options.rules);
  }

  return emptyBundle();
}

export function normalizeBundle(b) {
  const enforcement = b?.enforcement ?? b?.mode;
  return {
    firewall: Array.isArray(b.firewall) ? b.firewall : [],
    whitelists: Array.isArray(b.whitelists) ? b.whitelists : [],
    whitelist_keys: b.whitelist_keys ?? {},
    ...(enforcement === 'block' || enforcement === 'dry-run' ? { enforcement } : {}),
  };
}

export function emptyBundle() {
  return { firewall: [], whitelists: [], whitelist_keys: {} };
}
