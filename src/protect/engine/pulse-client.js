const DEFAULT_BASE_URL = 'https://api.patchstack.com/monitor/pulse';
const DEFAULT_CACHE_TTL = 300_000;

// Per-site rules client for Pulse (npm/JS) apps. Public endpoint — the site UUID is the only
// credential, passed in the path. Fail-open: any error returns success:false + empty rules so
// createProtection falls back to the disk cache or the bundled rules.
export class PulseRuleClient {
  #siteUuid;
  #baseUrl;
  #cacheTtl;
  #cache = null;
  #cacheTime = null;

  constructor({ siteUuid, baseUrl, cacheTtl } = {}) {
    this.#siteUuid = siteUuid ?? process.env.PATCHSTACK_SITE_UUID;
    this.#baseUrl = baseUrl ?? process.env.PATCHSTACK_PULSE_RULES_URL ?? DEFAULT_BASE_URL;
    this.#cacheTtl = cacheTtl ?? DEFAULT_CACHE_TTL;
    if (!this.#siteUuid) {
      throw new Error('Patchstack site UUID is required. Pass { siteUuid } or set PATCHSTACK_SITE_UUID.');
    }
  }

  async getRules() {
    const now = Date.now();
    if (this.#cache && this.#cacheTime && now - this.#cacheTime < this.#cacheTtl) {
      return this.#cache;
    }
    const url = `${this.#baseUrl}/rules/${encodeURIComponent(this.#siteUuid)}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        return { success: false, error: `API returned ${response.status}`, firewall: [], whitelists: [], whitelist_keys: {} };
      }
      const data = await response.json();
      const result = {
        success: true,
        firewall: Array.isArray(data.firewall) ? data.firewall : [],
        whitelists: Array.isArray(data.whitelists) ? data.whitelists : [],
        whitelist_keys: data.whitelist_keys ?? {},
      };
      this.#cache = result;
      this.#cacheTime = now;
      return result;
    } catch (err) {
      return {
        success: false,
        error: err.name === 'TimeoutError' ? 'Request timed out' : err.message,
        firewall: [], whitelists: [], whitelist_keys: {},
      };
    }
  }

  clearCache() {
    this.#cache = null;
    this.#cacheTime = null;
  }
}
