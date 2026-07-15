const DEFAULT_BASE_URL = 'https://api.patchstack.com';
const DEFAULT_CACHE_TTL = 300_000;
// Randomly shorten the effective TTL by up to this fraction so many long-lived clients don't all
// revalidate on the same tick (spreads load against the rules API).
const JITTER_FRACTION = 0.1;

// Token-authenticated rules client. Conditional fetch (If-None-Match / 304) and the persisted
// `etag` mirror PulseRuleClient; both are a no-op until the API emits an ETag and honors the
// conditional request — with no ETag in the response the client behaves as before (full fetch).
export class PatchstackRuleClient {
  #token;
  #baseUrl;
  #cacheTtl;
  #cache = null;
  #cacheTime = null;
  #ttlEffective = 0;
  #etag;

  constructor({ token, baseUrl, cacheTtl, etag } = {}) {
    this.#token = token ?? process.env.PATCHSTACK_WAF_TOKEN;
    this.#baseUrl = baseUrl ?? process.env.PATCHSTACK_WAF_API_URL ?? DEFAULT_BASE_URL;
    this.#cacheTtl = cacheTtl ?? DEFAULT_CACHE_TTL;
    this.#etag = etag ?? null;

    if (!this.#token) {
      throw new Error('Patchstack WAF token is required. Pass { token } or set PATCHSTACK_WAF_TOKEN env var.');
    }
  }

  async getRules() {
    const now = Date.now();

    if (this.#cache && this.#cacheTime !== null && (now - this.#cacheTime) < this.#ttlEffective) {
      return this.#cache;
    }

    const url = `${this.#baseUrl}/api/get-rules/3`;

    try {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.#token}`,
        'LicenseID': '1' // Hard-coded, is never actually used but needed by the API
      };
      if (this.#etag) headers['If-None-Match'] = this.#etag;

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30_000)
      });

      if (response.status === 304) {
        this.#touch(now); // revalidated — reset the clock (fresh jitter)
        return this.#cache ?? { success: true, notModified: true, etag: this.#etag, firewall: [], whitelists: [], whitelist_keys: {} };
      }

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
        notModified: false,
        etag: response.headers?.get?.('etag') ?? null,
        firewall: Array.isArray(data.firewall) ? data.firewall : [],
        whitelists: Array.isArray(data.whitelists) ? data.whitelists : [],
        whitelist_keys: data.whitelist_keys ?? {}
      };

      this.#cache = result;
      this.#etag = result.etag;
      this.#touch(now);

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
