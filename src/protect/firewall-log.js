import { isSafeOrigin, safeBaseUrl } from './safe-origin.js';
import { readBoundedJson } from '../bounded-response.js';
// Fire-and-forget reporter: Connect runtime → existing connector POST /api/logs/log
// (same path WordPress uses). Auth: WP-style api_key (`{secret}-{oauth.id}`) →
// POST /oauth/token (client_credentials) → Bearer JWT on /api/logs/log.
// Opt out: PATCHSTACK_TELEMETRY=off. Never put api_key in the public widget.

const DEFAULT_API_BASE = 'https://api.patchstack.com';
/** The shutdown budget, matching the detection reporter's. */
const STOP_BUDGET_MS = 5_000;
const ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_FLUSH_MS = 1000;
const MAX_BATCH = 50;
const MAX_QUEUE = 500;
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
      const candidate = new URL(pulseOrManifestUrl).origin;
      if (isSafeOrigin(candidate)) return candidate;
    } catch {
      /* fall through */
    }
  }
  const endpoint = typeof process !== 'undefined' ? process.env?.PATCHSTACK_ENDPOINT : undefined;
  if (typeof endpoint === 'string' && endpoint.length > 0) {
    try {
      const candidate = new URL(endpoint).origin;
      if (isSafeOrigin(candidate)) return candidate;
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
    return { record() {}, flush: () => Promise.resolve(), stop: () => Promise.resolve() };
  }

  const apiBase = safeBaseUrl(opts.apiBase, DEFAULT_API_BASE, 'block-log API').replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const flushMs = Number.isFinite(opts.flushMs) ? opts.flushMs : DEFAULT_FLUSH_MS;
  const sourceHost = typeof opts.sourceHost === 'string' ? opts.sourceHost : '';

  /** @type {Array<Record<string, unknown>>} */
  let queue = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let stopped = false;
  /** At most one delivery may be active; additional records remain in the bounded queue. */
  /** @type {Promise<void> | null} */
  let inFlight = null;
  /** @type {Promise<void> | null} */
  let drainPromise = null;
  /** @type {AbortController | null} */
  let activeController = null;
  /** Set when a shutdown gives up waiting: nothing may start, continue, or be retained after it. */
  let ended = false;

  /** @type {{ token: string, expiresAt: number } | null} */
  let cachedToken = null;
  /** @type {Promise<string | null> | null} */
  let tokenInflight = null;

  const fetchAccessToken = async (signal) => {
    if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_SKEW_MS) {
      return cachedToken.token;
    }
    if (tokenInflight) return tokenInflight;

    tokenInflight = (async () => {
      try {
        const res = await fetchImpl(`${apiBase}/oauth/token`, {
          method: 'POST',
          ...(signal ? { signal } : {}),
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
        const body = await readBoundedJson(res);
        const token = body?.access_token;
        if (typeof token !== 'string' || token.length === 0 || token.length > 8_192 || /[\u0000-\u0020\u007f-\u009f]/.test(token)) return null;
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
    if (ended || typeof fetchImpl !== 'function') return Promise.resolve();
    if (inFlight) return inFlight;
    if (queue.length === 0) return Promise.resolve();

    const batch = queue.splice(0, MAX_BATCH);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeController = controller;
    const attemptTimer = setTimeout(() => controller?.abort(), ATTEMPT_TIMEOUT_MS);
    attemptTimer?.unref?.();

    // Returned so a shutdown can wait for it, and tracked so a shutdown can find it even when the queue
    // it came from is already empty. It never rejects: a caller that ignores it must not produce an
    // unhandled rejection, and one that awaits it is waiting for the attempt to finish, not asking
    // whether it succeeded.
    /** @type {Promise<void>} */
    let entry;
    entry = (async () => {
      try {
        const token = await fetchAccessToken(controller?.signal);
        // Not after a shutdown gave up: it has already reported itself finished.
        if (!token || ended) return;

        const body = new URLSearchParams();
        body.set('type', 'firewall');
        body.set('logs', JSON.stringify(batch));

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
          // Both phases carry the attempt controller, so slow transports cannot accumulate work.
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (p && typeof p.then === 'function') await p.catch(() => {});
      } catch {
        /* A delivery problem is never worth disturbing the app over. */
      } finally {
        clearTimeout(attemptTimer);
        if (activeController === controller) activeController = null;
        if (inFlight === entry) inFlight = null;
        if (!stopped && !ended && queue.length > 0 && !timer) {
          timer = setTimeout(flush, queue.length >= MAX_BATCH ? 0 : flushMs);
          timer?.unref?.();
        }
      }
    })();

    inFlight = entry;

    return entry;
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

      if (queue.length >= MAX_QUEUE) return;
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
    /**
     * Stop, and hand back a wait for what was outstanding.
     *
     * One flush sends at most a batch, so the queue is drained a batch at a time. The loop stops as soon
     * as a pass cannot shrink the queue — with no usable transport there is nothing to wait for, and
     * spinning would be worse than leaving the records where they are.
     */
    stop() {
      // The same wait every time. A second call must not hand back a resolved promise while the first
      // drain is still running, and must not start a second drain behind it.
      if (drainPromise) return drainPromise;
      stopped = true;
      // Before anything else. An armed interval would otherwise fire mid-drain, take the queued records
      // for itself, and start a send the drain never learns about — leaving the drain to look at an empty
      // queue, conclude it is finished, and resolve with that send still open.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      /**
       * End the drain, rather than merely stop waiting for it.
       *
       * Racing the wait against a timer would leave the work alive: still blocked, still holding its
       * entry, and free to run another flush if the transport answered later — after the shutdown had
       * reported itself finished. So the reporter is marked ended, which closes `flush` and the loop
       * below, the open requests are aborted, and what was never sent is discarded rather than retained
       * by a reporter nobody will read again.
       */
      const terminate = () => {
        ended = true;
        activeController?.abort();
        activeController = null;
        queue = [];
        inFlight = null;
      };

      /** @type {ReturnType<typeof setTimeout> | null} */
      let budget = null;
      // Bounded like the detection reporter's, and for the same reason: a hung transport would otherwise
      // keep a shutdown pending for as long as the process lived, which is not a bounded shutdown.
      const spent = new Promise((resolve) => {
        budget = setTimeout(() => {
          terminate();
          resolve();
        }, STOP_BUDGET_MS);
        if (typeof budget.unref === 'function') budget.unref();
      });

      const work = (async () => {
        // Two things can be outstanding and each can produce the other: a send holds records that have
        // left the queue, and the queue holds records that will become a send. So this asks again after
        // every wait rather than taking one snapshot — a snapshot resolves as soon as the sends it
        // happened to capture are done, whatever appeared in the meantime.
        //
        // It ends when both are empty, when a pass cannot shrink the queue (with no usable transport
        // there is nothing to wait for, and spinning would be worse), or when the budget ends it.
        while (!ended) {
          if (inFlight) {
            await inFlight;
            continue;
          }
          if (queue.length === 0) break;
          const before = queue.length;
          await flush();
          if (queue.length >= before) break;
        }
      })();

      drainPromise = Promise.race([work, spent]).then(() => {
        if (budget) clearTimeout(budget);
      });

      return drainPromise;
    },
  };
}

/** @returns {boolean} */
export function telemetryEnabled() {
  const v = typeof process !== 'undefined' ? process.env?.PATCHSTACK_TELEMETRY : undefined;
  if (v === undefined || v === '') return true;
  return !/^(0|false|off|no)$/i.test(String(v));
}
