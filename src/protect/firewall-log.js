import { isSafeOrigin } from './safe-origin.js';
// Fire-and-forget reporter: Connect runtime → existing connector POST /api/logs/log
// (same path WordPress uses). Auth: WP-style api_key (`{secret}-{oauth.id}`) →
// POST /oauth/token (client_credentials) → Bearer JWT on /api/logs/log.
// Opt out: PATCHSTACK_TELEMETRY=off. Never put api_key in the public widget.

const DEFAULT_API_BASE = 'https://api.patchstack.com';
const DEFAULT_FLUSH_MS = 1000;
const MAX_BATCH = 50;
const TOKEN_SKEW_MS = 60_000;

/**
 * Parse WP plugin api_key (`{secret}-{oauth.id}`) into client credentials.
 * @param {string} apiKey
 * @returns {{ clientId: string, clientSecret: string } | null}
 */
export function parseApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
  const idx = apiKey.lastIndexOf('-');
  if (idx <= 0 || idx === apiKey.length - 1) return null;
  const clientSecret = apiKey.slice(0, idx);
  const clientId = apiKey.slice(idx + 1);
  if (!/^\d+$/.test(clientId) || clientSecret.length === 0) return null;
  return { clientId, clientSecret };
}

/**
 * Derive api.patchstack.com origin from a Pulse manifest/rules URL override.
 * @param {string | undefined} pulseOrManifestUrl
 */
export function resolveApiBase(pulseOrManifestUrl) {
  const fromEnv = typeof process !== 'undefined' ? process.env?.PATCHSTACK_API_BASE : undefined;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    // The site api_key is exchanged for a token against this origin, so a hostile/injected env value
    // would be a credential-exfiltration path. Require HTTPS (localhost excepted for local testing);
    // anything else falls back to the default origin rather than shipping the key off-platform.
    const candidate = fromEnv.replace(/\/$/, '');
    if (isSafeOrigin(candidate)) return candidate;
    // eslint-disable-next-line no-console
    console.warn(
      '[patchstack] ignoring PATCHSTACK_API_BASE: block-log reporting requires an https origin ' +
        '(or localhost). Falling back to the default API origin.',
    );
  }
  if (typeof pulseOrManifestUrl === 'string' && pulseOrManifestUrl.length > 0) {
    try {
      return new URL(pulseOrManifestUrl).origin;
    } catch {
      /* fall through */
    }
  }
  const endpoint = typeof process !== 'undefined' ? process.env?.PATCHSTACK_ENDPOINT : undefined;
  if (typeof endpoint === 'string' && endpoint.length > 0) {
    try {
      return new URL(endpoint).origin;
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_API_BASE;
}

/**
 * @param {{
 *   apiKey: string,
 *   apiBase?: string,
 *   sourceHost?: string,
 *   fetchImpl?: typeof fetch,
 *   flushMs?: number,
 * }} opts
 */
export function createFirewallLogReporter(opts) {
  const creds = parseApiKey(opts.apiKey);
  if (!creds) {
    return { record() {}, flush() {}, stop() {} };
  }

  const apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const flushMs = Number.isFinite(opts.flushMs) ? opts.flushMs : DEFAULT_FLUSH_MS;
  const sourceHost = typeof opts.sourceHost === 'string' ? opts.sourceHost : '';

  /** @type {Array<Record<string, unknown>>} */
  let queue = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let stopped = false;

  /** @type {{ token: string, expiresAt: number } | null} */
  let cachedToken = null;
  /** @type {Promise<string | null> | null} */
  let tokenInflight = null;

  const fetchAccessToken = async () => {
    if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_SKEW_MS) {
      return cachedToken.token;
    }
    if (tokenInflight) return tokenInflight;

    tokenInflight = (async () => {
      try {
        const res = await fetchImpl(`${apiBase}/oauth/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': '@patchstack/connect',
          },
          body: JSON.stringify({
            grant_type: 'client_credentials',
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
          }),
        });
        if (!res || !res.ok) return null;
        const body = await res.json();
        const token = body?.access_token;
        if (typeof token !== 'string' || token.length === 0) return null;
        const expiresIn = Number(body?.expires_in);
        const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000;
        cachedToken = { token, expiresAt: Date.now() + ttlMs };
        return token;
      } catch {
        return null;
      } finally {
        tokenInflight = null;
      }
    })();

    return tokenInflight;
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.length === 0 || typeof fetchImpl !== 'function') return;

    const batch = queue.splice(0, MAX_BATCH);
    void (async () => {
      const token = await fetchAccessToken();
      if (!token) return;

      const body = new URLSearchParams();
      body.set('type', 'firewall');
      body.set('logs', JSON.stringify(batch));

      try {
        const p = fetchImpl(`${apiBase}/api/logs/log`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': '@patchstack/connect',
            ...(sourceHost ? { 'Source-Host': sourceHost } : {}),
          },
          body,
        });
        if (p && typeof p.then === 'function') p.catch(() => {});
      } catch {
        /* ignore */
      }
    })();
  };

  return {
    /**
     * @param {{
     *   rule?: { id?: string | number },
     *   method?: string | null,
     *   path?: string | null,
     *   ip?: string | null,
     *   userAgent?: string | null,
     * }} event
     */
    record(event) {
      if (stopped) return;
      const fid = event?.rule?.id;
      if (fid === undefined || fid === null || fid === '') return;

      queue.push({
        fid,
        method: event.method ?? null,
        request_uri: event.path ?? null,
        ip: event.ip ?? null,
        user_agent: event.userAgent ?? null,
        log_date: new Date().toISOString(),
      });

      if (queue.length >= MAX_BATCH) {
        flush();
        return;
      }
      if (!timer) timer = setTimeout(flush, flushMs);
    },
    flush,
    stop() {
      stopped = true;
      flush();
    },
  };
}

/** @returns {boolean} */
export function telemetryEnabled() {
  const v = typeof process !== 'undefined' ? process.env?.PATCHSTACK_TELEMETRY : undefined;
  if (v === undefined || v === '') return true;
  return !/^(0|false|off|no)$/i.test(String(v));
}
