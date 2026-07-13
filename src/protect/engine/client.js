const DEFAULT_BASE_URL = 'https://api.patchstack.com';
const DEFAULT_CACHE_TTL = 300_000;

export class PatchstackRuleClient {
  #token;
  #baseUrl;
  #cacheTtl;
  #cache = null;
  #cacheTime = null;

  constructor({ token, baseUrl, cacheTtl } = {}) {
    this.#token = token ?? process.env.PATCHSTACK_WAF_TOKEN;
    this.#baseUrl = baseUrl ?? process.env.PATCHSTACK_WAF_API_URL ?? DEFAULT_BASE_URL;
    this.#cacheTtl = cacheTtl ?? DEFAULT_CACHE_TTL;

    if (!this.#token) {
      throw new Error('Patchstack WAF token is required. Pass { token } or set PATCHSTACK_WAF_TOKEN env var.');
    }
  }

  async getRules() {
    const now = Date.now();

    if (this.#cache && this.#cacheTime && (now - this.#cacheTime) < this.#cacheTtl) {
      return this.#cache;
    }

    const url = `${this.#baseUrl}/api/get-rules/3`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.#token}`,
          'LicenseID': '1' // Hard-coded, is never actually used but needed by the API
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30_000)
      });

      if (!response.ok) {
        return {
          success: false,
          error: `API returned ${response.status}: ${response.statusText}`,
          firewall: [],
          whitelists: [],
          whitelist_keys: {}
        };
      }

      const data = await response.json();

      const result = {
        success: true,
        firewall: Array.isArray(data.firewall) ? data.firewall : [],
        whitelists: Array.isArray(data.whitelists) ? data.whitelists : [],
        whitelist_keys: data.whitelist_keys ?? {}
      };

      this.#cache = result;
      this.#cacheTime = now;

      return result;
    } catch (err) {
      return {
        success: false,
        error: err.name === 'TimeoutError'
          ? 'Request timed out'
          : err.message,
        firewall: [],
        whitelists: [],
        whitelist_keys: {}
      };
    }
  }

  clearCache() {
    this.#cache = null;
    this.#cacheTime = null;
  }
}
