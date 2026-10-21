import { pulseFetch } from '../pulse-token.js';
import { isSafeOrigin } from './safe-origin.js';

const DEFAULT_BASE_URL = 'https://api.patchstack.com/monitor/pulse';
// How long before a failed report is attempted again, so a slow or down platform is retried by a later
// request without one report attempt per request.
const RETRY_COOLDOWN_MS = 60_000;
// A deliberately tight bound: this runs inline on the FIRST request the guard serves on a new origin, so a
// slow platform must not hold that request open. It is best-effort — a miss is retried on a later request.
const ATTEMPT_TIMEOUT_MS = 1_500;

/** A host nobody else can reach is not a live deployment, whatever it serves. */
function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0'
    || hostname === '::1' || hostname === '[::1]' || hostname.endsWith('.local');
}

/**
 * Tell Patchstack the deployment is live, from the running server itself.
 *
 * The browser widget only checks in when a real browser loads the page, so a server-rendered app with no
 * visitors yet — or one Patchstack cannot reach to observe — never registers as deployed even while its
 * guard is plainly running. The guard knows what the widget would report (the public host it serves), and
 * it is already making authenticated requests, so it reports it once per origin.
 *
 * Sent INLINE on the first request for an origin rather than as background work: an edge runtime freezes
 * the moment it answers, which cancels a fire-and-forget request, and the context needed for `waitUntil`
 * is not reachable from every framework seam. One request paying for one short POST, once per process, is
 * the price of not depending on it. Best-effort and fail-open throughout.
 *
 * @param {{ siteUuid?: string, pulseAuth?: string, baseUrl?: string, fetchImpl?: typeof fetch }} opts
 */
export function createLiveReporter(opts) {
  const siteUuid = opts.siteUuid;
  const pulseAuth = opts.pulseAuth;
  if (typeof siteUuid !== 'string' || siteUuid === '' || typeof pulseAuth !== 'string' || pulseAuth === '') {
    return { note: async () => {} };
  }

  const configured = opts.baseUrl ?? (typeof process !== 'undefined' ? process.env?.PATCHSTACK_PULSE_RULES_URL : undefined);
  const baseUrl = (typeof configured === 'string' && isSafeOrigin(configured) ? configured : DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/live/${encodeURIComponent(siteUuid)}`;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : undefined;

  const reported = new Set();
  let nextAttemptAt = 0;

  return {
    /**
     * Report that this guard is serving `origin` (and, when known, the build it was cut from). A no-op
     * after the first success for that origin, and throttled between failed attempts.
     *
     * @param {string | undefined} origin  the public origin the guard is serving (scheme://host[:port])
     * @param {string | undefined} [checksum]  the build fingerprint, when the guard was shipped with one
     */
    async note(origin, checksum) {
      if (typeof origin !== 'string' || origin === '' || reported.has(origin)) return;
      let host;
      try { host = new URL(origin).hostname; } catch { return; }
      if (host === '' || isLocalHost(host)) return;
      if (Date.now() < nextAttemptAt) return;
      nextAttemptAt = Date.now() + RETRY_COOLDOWN_MS;

      try {
        const response = await pulseFetch(
          { pulseAuth, endpoint: baseUrl, timeoutMs: ATTEMPT_TIMEOUT_MS },
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': '@patchstack/connect' },
            body: JSON.stringify({ origin, ...(typeof checksum === 'string' && checksum !== '' ? { checksum } : {}) }),
          },
          fetchImpl,
        );
        if (response && response.ok) reported.add(origin); // delivered — never again this process
      } catch {
        /* fail open; the cooldown lets a later request try again */
      }
    },
  };
}
