const DEFAULT_BASE_URL = 'https://api.patchstack.com/monitor/pulse';
const DEFAULT_CACHE_TTL = 300_000;
// Randomly shorten the effective TTL by up to this fraction so many long-lived clients don't all
// revalidate on the same tick (spreads load / avoids a thundering herd against the rules API).
const JITTER_FRACTION = 0.1;

// Per-site rules client for Pulse (npm/JS) apps. Public endpoint — the site UUID is the only
// credential, passed in the path. Fail-open: any error returns success:false + empty rules so
// createProtection falls back to the disk cache or the bundled rules.
//
// Conditional fetch: pass a prior `etag` (persisted with the last cached bundle) and the client
// sends `If-None-Match`; a 304 returns `{ notModified: true }` so the caller reuses its cache
// without re-downloading, and a 200 returns the new bundle plus its `etag` to persist. This is a
// no-op until the rules API emits an ETag and honors If-None-Match — with no ETag in the response
// the client simply behaves as before (a full fetch every refresh).
export class PulseRuleClient {
  #siteUuid;
  #baseUrl;
  #cacheTtl;
  #cache = null;
  #cacheTime = null;
  #ttlEffective = 0;
  #etag;

  constructor({ siteUuid, baseUrl, cacheTtl, etag } = {}) {
    this.#siteUuid = siteUuid ?? process.env.PATCHSTACK_SITE_UUID;
    this.#baseUrl = baseUrl ?? process.env.PATCHSTACK_PULSE_RULES_URL ?? DEFAULT_BASE_URL;
    this.#cacheTtl = Number.isFinite(cacheTtl) && cacheTtl > 0 ? cacheTtl : DEFAULT_CACHE_TTL;
    this.#etag = etag ?? null;
    if (!this.#siteUuid) {
      throw new Error('Patchstack site UUID is required. Pass { siteUuid } or set PATCHSTACK_SITE_UUID.');
    }
  }

  async getRules() {
    const now = Date.now();
    if (this.#cache && this.#cacheTime !== null && now - this.#cacheTime < this.#ttlEffective) {
      return this.#cache;
    }
    const url = `${this.#baseUrl}/rules/${encodeURIComponent(this.#siteUuid)}`;
    try {
      const headers = { Accept: 'application/json' };
      if (this.#etag) headers['If-None-Match'] = this.#etag;
      const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) });

      if (response.status === 304) {
        this.#touch(now); // revalidated — reset the clock (fresh jitter)
        return this.#cache ?? { success: true, notModified: true, etag: this.#etag, firewall: [], whitelists: [], whitelist_keys: {} };
      }
      if (!response.ok) {
        return { success: false, error: `API returned ${response.status}`, firewall: [], whitelists: [], whitelist_keys: {} };
      }
      const data = await response.json();
      // A 200 that isn't a genuine rule envelope (schema drift, a proxy/interstitial page, an
      // {error} body) must not be treated as "no rules". Report failure so the caller falls back to
      // the cache / bundled rules rather than caching an empty bundle.
      if (!data || !Array.isArray(data.firewall)) {
        return { success: false, error: 'unexpected response shape (no firewall array)', firewall: [], whitelists: [], whitelist_keys: {} };
      }
      const result = {
        success: true,
        notModified: false,
        etag: response.headers?.get?.('etag') ?? null,
        firewall: data.firewall,
        whitelists: Array.isArray(data.whitelists) ? data.whitelists : [],
        whitelist_keys: data.whitelist_keys ?? {},
        ...enforcementField(data),
      };
      this.#cache = result;
      this.#etag = result.etag;
      this.#touch(now);
      return result;
    } catch (err) {
      return {
        success: false,
        error: err.name === 'TimeoutError' ? 'Request timed out' : err.message,
        firewall: [], whitelists: [], whitelist_keys: {},
      };
    }
  }

  #touch(now) {
    this.#cacheTime = now;
    this.#ttlEffective = this.#cacheTtl - Math.floor(Math.random() * this.#cacheTtl * JITTER_FRACTION);
  }

  clearCache() {
    this.#cache = null;
    this.#cacheTime = null;
    this.#etag = null;
  }
}

/** @param {unknown} data @returns {{ enforcement?: 'block'|'dry-run' }} */
function enforcementField(data) {
  if (!data || typeof data !== 'object') return {};
  const v = data.enforcement ?? data.mode;
  return v === 'block' || v === 'dry-run' ? { enforcement: v } : {};
}
