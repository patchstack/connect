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

/** The client-most value of a comma-joined forwarded header, trimmed, or undefined when there is none. */
function firstToken(value) {
  if (typeof value !== 'string') return undefined;
  const first = value.split(',')[0]?.trim();
  return first !== undefined && first !== '' ? first : undefined;
}

/**
 * The `host` and `proto` of the first element of an RFC 7239 `Forwarded` header, if present.
 * A minimal parse: enough to recover the public address, not a general implementation.
 */
function parseForwarded(value) {
  if (typeof value !== 'string' || value === '') return {};
  const out = {};
  for (const part of (value.split(',')[0] ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const val = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (key === 'host' && val !== '') out.host = val;
    else if (key === 'proto' && val !== '') out.proto = val;
  }
  return out;
}

/**
 * The public origin the guard is serving, as the proxy in front of it presents it.
 *
 * `request.url` names the public address only when the app terminates its own connections. Behind a reverse
 * proxy — which is every hosted builder's deployment, and some frameworks' own dev server — the app sees an
 * internal host there (a container name, a loopback, a bare port), while the address a visitor actually used
 * rides the forwarded headers the proxy sets. Prefer those, then the `Host` header, and fall back to
 * `request.url`. Best-effort: a wrong guess is a liveness report the platform vets before it adopts a URL,
 * not a security decision.
 *
 * @param {Request} request
 * @returns {string | undefined} an origin (`scheme://host[:port]`), or undefined when none can be formed
 */
export function publicOriginOf(request) {
  const headers = request?.headers;
  if (!headers || typeof headers.get !== 'function') {
    try { return new URL(request.url).origin; } catch { return undefined; }
  }

  const forwarded = parseForwarded(headers.get('forwarded'));
  const forwardedHost = firstToken(headers.get('x-forwarded-host')) ?? forwarded.host;
  const host = forwardedHost ?? headers.get('host') ?? undefined;
  if (typeof host === 'string' && host !== '') {
    let proto = firstToken(headers.get('x-forwarded-proto')) ?? forwarded.proto;
    if (proto === undefined) {
      // A forwarded host means a proxy sits in front, so `request.url`'s scheme is the internal hop's, not
      // the visitor's — default to https, the public scheme. A bare Host header is the hop we were reached
      // on, so its own scheme is the honest one.
      if (forwardedHost !== undefined) proto = 'https';
      else { try { proto = new URL(request.url).protocol.replace(/:$/, ''); } catch { /* keep undefined */ } }
    }
    try { return new URL(`${proto || 'https'}://${host}`).origin; } catch { /* fall through to request.url */ }
  }

  try { return new URL(request.url).origin; } catch { return undefined; }
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
