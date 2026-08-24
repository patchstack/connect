import type { Config } from './types.js';

/**
 * Bearer tokens for the authenticated Pulse endpoints (ADR-0018).
 *
 * Deliberately separate from the block-log token flow in
 * `src/protect/firewall-log.js`: that path talks to the auth/ Lambda's
 * /oauth/token and must keep working exactly as it does today.
 */

const TOKEN_SKEW_MS = 60_000;

/** Build the Pulse token URL corresponding to a manifest endpoint override. */
export function buildTokenUrl(manifestEndpoint: string): string {
  const url = new URL(manifestEndpoint);
  const path = url.pathname.replace(/\/$/, '');
  url.pathname = path.endsWith('/manifest')
    ? `${path.slice(0, -'/manifest'.length)}/token`
    : '/monitor/pulse/token';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Split the WP-format `{secret}-{oauth.id}` credential on its last hyphen. */
export function parsePulseAuth(credential: string): { clientId: string; clientSecret: string } | null {
  const index = credential.lastIndexOf('-');
  if (index <= 0 || index === credential.length - 1) return null;

  const clientId = credential.slice(index + 1);
  if (!/^\d+$/.test(clientId)) return null;

  return { clientId, clientSecret: credential.slice(0, index) };
}

let cached: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string | null> | null = null;

/** Drops the cached token. Exported for tests and for 401 handling. */
export function clearPulseToken(): void {
  cached = null;
}

/**
 * Resolve a bearer token for `config.pulseAuth`, exchanging one if needed.
 *
 * Returns null whenever a token cannot be obtained — no credential, a rejected
 * exchange, a network failure. Callers then send the request unauthenticated,
 * and every site-addressed Pulse endpoint refuses it: only a first-time
 * provisioning call is anonymous. Returning null rather than throwing keeps that
 * refusal on the caller's own error path, where it can fall back or report.
 */
export async function getPulseToken(
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  // Not `=== null`: Config is public, so callers can hand us an object that
  // predates this field, and an unusable credential must never throw here.
  if (typeof config.pulseAuth !== 'string' || config.pulseAuth.length === 0) return null;

  if (cached !== null && Date.now() < cached.expiresAt - TOKEN_SKEW_MS) {
    return cached.token;
  }
  if (inflight !== null) return inflight;

  const credentials = parsePulseAuth(config.pulseAuth);
  if (credentials === null) return null;

  inflight = (async () => {
    try {
      const response = await fetchImpl(buildTokenUrl(config.endpoint), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': '@patchstack/connect',
        },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      if (!response.ok) return null;

      const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== 'string' || body.access_token.length === 0) return null;

      const expiresIn = Number(body.expires_in);
      const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000;
      cached = { token: body.access_token, expiresAt: Date.now() + ttlMs };

      return body.access_token;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * `Authorization` header for a Pulse request, or `{}` when unauthenticated.
 * Spread into an existing header object so call sites stay one line.
 */
export async function pulseAuthHeader(
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  const token = await getPulseToken(config, fetchImpl);
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

/**
 * Send a Pulse request, attaching the bearer token and retrying once if the
 * server rejects it.
 *
 * A cached token can stop being valid before it expires — the credential may
 * have been rotated or revoked meanwhile — so the server's 401 is authoritative
 * over our own clock. Without this a long-running process would keep presenting
 * a dead token until its local expiry.
 *
 * Only 401 retries: a 403 is a scope or site mismatch, which a fresh token
 * would not fix.
 */
export async function pulseFetch(
  config: Config,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const send = async () => {
    const auth = await pulseAuthHeader(config, fetchImpl);
    const response = await fetchImpl(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), ...auth },
    });

    return { response, authenticated: auth.Authorization !== undefined };
  };

  const first = await send();

  // Retrying an unauthenticated request would just repeat it: the 401 was
  // about something other than our token.
  if (first.response.status === 401 && first.authenticated) {
    clearPulseToken();

    return (await send()).response;
  }

  return first.response;
}
