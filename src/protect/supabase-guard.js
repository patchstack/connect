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

// Headers we must not copy verbatim when re-emitting the upstream response.
const HOP_BY_HOP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

/**
 * @param {object} opts
 * @param {{ fetchGuard: () => (req: Request) => Promise<Response|null> }} opts.protection  a createProtection() result
 * @param {string|undefined} opts.supabaseUrl  the app's Supabase project URL (server-side env) — the only allowed forward target
 * @param {typeof fetch} [opts.fetchImpl]  injectable fetch (tests)
 * @returns {(request: Request) => Promise<Response>}
 */
export function createSupabaseGuard({ protection, supabaseUrl, fetchImpl = fetch }) {
  const guard = protection.fetchGuard();
  const allowedOrigin = supabaseUrl ? new URL(supabaseUrl).origin : null;

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
    const bodyText = hasBody ? await request.text() : '';

    // Evaluate the tunneled call against the policy. fetchGuard returns a 403 Response when it
    // blocks (block mode + match), or null to allow (allow, or dry-run — it records via onDetect).
    const evalReq = new Request(targetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: hasBody ? bodyText : undefined,
    });
    const blocked = await guard(evalReq);
    if (blocked) return blocked;

    // Allowed → forward to Supabase, server-side.
    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.delete('x-ps-target');
    forwardHeaders.delete('host');
    const upstream = await fetchImpl(targetUrl.toString(), {
      method: request.method,
      headers: forwardHeaders,
      body: hasBody ? bodyText : undefined,
      redirect: 'manual',
    });

    const outHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders.set(key, value);
    });
    const buf = await upstream.arrayBuffer();
    return new Response(buf, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders });
  };
}
