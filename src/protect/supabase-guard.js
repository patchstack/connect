// Supabase-tunnel guard for AI-builder apps (Lovable / TanStack Start + Supabase).
//
// The vibe-coded app's browser talks straight to Supabase, bypassing the app's own server —
// so a normal in-app WAF never sees the data traffic. The installer patches the generated
// Supabase client to tunnel every call through this guard (running in the app's own server /
// Worker). The guard runs the Patchstack protection policy on the tunneled request, then
// forwards it to Supabase — pinned to the app's own project so it can't be turned into an
// open proxy (SSRF).
//
// The heavy lifting (rule evaluation, dry-run/block, fail-open) is `protection.fetchGuard()`
// from `createProtection` — this module is just the Supabase-specific tunnel around it.

export const GUARD_PATH = '/_patchstack/guard';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

// The tunnel is same-origin to the browser, but its destination is a different service. Browser/session
// credentials and proxy routing metadata belong to the app origin and must stop at that boundary.
const REQUEST_HEADER_DENYLIST = new Set([
  'connection', 'cookie', 'cookie2', 'forwarded', 'host', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto', 'x-ps-target', 'x-real-ip',
]);

// Headers we must not copy verbatim when re-emitting the upstream response. In particular, a cookie
// issued by the destination must not become a cookie for the app origin that owns this route.
const RESPONSE_HEADER_DENYLIST = new Set([
  'connection', 'content-encoding', 'content-length', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'set-cookie', 'set-cookie2', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

class BodyTooLargeError extends Error {}

async function boundedBody(request, maxBytes) {
  const stated = Number(request.headers.get('content-length'));
  if (Number.isFinite(stated) && stated > maxBytes) throw new BodyTooLargeError();
  if (!request.body) return undefined;

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function requestHeaders(input) {
  const output = new Headers();
  const connectionTokens = new Set(
    (input.get('connection') ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  input.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!REQUEST_HEADER_DENYLIST.has(lower) && !connectionTokens.has(lower)) output.append(key, value);
  });
  return output;
}

function responseHeaders(input) {
  const output = new Headers();
  const connectionTokens = new Set(
    (input.get('connection') ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  input.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!RESPONSE_HEADER_DENYLIST.has(lower) && !connectionTokens.has(lower)) output.append(key, value);
  });
  return output;
}

/**
 * @param {object} opts
 * @param {{ fetchGuard: () => (req: Request) => Promise<Response|null> }} opts.protection  a createProtection() result
 * @param {string|undefined} opts.supabaseUrl  the app's Supabase project URL (server-side env) — the only allowed forward target
 * @param {typeof fetch} [opts.fetchImpl]  injectable fetch (tests)
 * @param {number} [opts.maxBodyBytes]  maximum tunneled request body size
 * @param {number} [opts.timeoutMs]  maximum upstream request duration
 * @returns {(request: Request) => Promise<Response>}
 */
export function createSupabaseGuard({
  protection,
  supabaseUrl,
  fetchImpl = fetch,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const guard = protection.fetchGuard();
  const allowedOrigin = supabaseUrl ? new URL(supabaseUrl).origin : null;
  const bodyLimit = Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : DEFAULT_MAX_BODY_BYTES;
  const upstreamTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  return async function handleGuardRequest(request) {
    const target = request.headers.get('x-ps-target');
    if (!target) return new Response('patchstack: missing x-ps-target', { status: 400 });

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response('patchstack: invalid target', { status: 400 });
    }

    // SSRF pin: only ever forward to the app's own Supabase project (origin from server-side
    // env, never the client-supplied header). Anything else — internal hosts, cloud metadata,
    // a different scheme — is rejected before any outbound request.
    if (!allowedOrigin || targetUrl.protocol !== 'https:' || targetUrl.origin !== allowedOrigin) {
      return new Response('patchstack: target not allowed', { status: 403 });
    }

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    let body;
    try {
      body = hasBody ? await boundedBody(request, bodyLimit) : undefined;
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return new Response('patchstack: request body too large', { status: 413 });
      }
      throw error;
    }
    const forwardHeaders = requestHeaders(request.headers);

    // Evaluate the tunneled call against the policy. fetchGuard returns a 403 Response when it
    // blocks (block mode + match), or null to allow (allow, or dry-run — it records via onDetect).
    const evalReq = new Request(targetUrl.toString(), {
      method: request.method,
      // Inspect what the browser sent, including app-origin cookies; only the forwarded copy is
      // sanitized at the cross-origin boundary below.
      headers: request.headers,
      body,
    });
    const blocked = await guard(evalReq);
    if (blocked) return blocked;

    // Allowed → forward to Supabase, server-side.
    let upstream;
    try {
      upstream = await fetchImpl(targetUrl.toString(), {
        method: request.method,
        headers: forwardHeaders,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(upstreamTimeout),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return new Response('patchstack: upstream timed out', { status: 504 });
      }
      throw error;
    }

    const forwarded = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream.headers),
    });

    // Response phase: screen what Supabase returned (query results can leak secrets/PII) —
    // redact the offending spans / withhold, per the response rules. Fail-open if unavailable.
    return protection.screenResponse ? protection.screenResponse(forwarded) : forwarded;
  };
}
