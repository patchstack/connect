// Patchstack runtime protection — installed by `patchstack-connect protect`; the vibe coder
// never touches this. It runs in the app's own server (e.g. the Cloudflare Worker) and covers
// both ways a Lovable app talks to its database:
//   - browser → Supabase directly: the generated Supabase client is patched to tunnel every call
//     through handleGuardRequest (registered as request middleware in src/start.ts).
//   - browser → TanStack server function → Supabase: inspectServerFn checks the server-fn args
//     (registered as function middleware in src/start.ts) before anything is written.
// Either way Patchstack sees the traffic and runs the same policy. It also screens the app's own
// OUTBOUND calls for SSRF (egress: true wraps the global fetch) — blocking requests to internal /
// cloud-metadata addresses while allowing the app's own Supabase project.
//
// Always-on by default (blocks). Rules come from the Patchstack API per-site (cached); the
// bundled rules.json is only a fallback for before a token is configured. The engine ships
// inside @patchstack/connect — nothing else to install.
import {
  createProtection,
  createSupabaseGuard,
  createServerFnGuard,
  GUARD_PATH,
} from "@patchstack/connect/protect";
import fallbackRules from "./rules.json";

// Baked by `patchstack-connect protect` from .patchstackrc.json (empty if the app isn't scanned yet).
const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";

export { GUARD_PATH };

// One shared protection policy for both guards (rules load once).
/**
 * One protection policy, memoized on the IN-FLIGHT promise rather than the resolved value.
 *
 * A cold start takes several concurrent requests. Caching only the finished value lets each of them see an
 * empty cache and start its own build — several rule fetches, several refresh loops, and several policies
 * where the app is meant to have one. Holding the promise means the first request starts it and the rest
 * await the same one. A failed build is not cached, so the next request retries rather than inheriting one
 * bad boot for the life of the process.
 */
let _protection: Promise<Awaited<ReturnType<typeof createProtection>>> | undefined;
async function getProtection() {
  if (!_protection) {
    _protection = buildProtection().catch((err) => {
      _protection = undefined; // don't cache a failed boot
      throw err;
    });
  }

  return _protection;
}

async function buildProtection() {
  // Always-on: block by default. An explicit PATCHSTACK_MODE=dry-run downgrades to log-only.
  const mode: "block" | "dry-run" = process.env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block";
  const token = process.env.PATCHSTACK_WAF_TOKEN;
  const siteUuid = PS_SITE_UUID.startsWith("__") ? process.env.PATCHSTACK_SITE_UUID : PS_SITE_UUID;
  // Egress SSRF screening: block the app's outbound calls to internal / metadata addresses,
  // but never its own Supabase project.
  let allowHosts: string[] = [];
  try {
    if (process.env.SUPABASE_URL) allowHosts = [new URL(process.env.SUPABASE_URL).host];
  } catch {
    /* ignore a malformed SUPABASE_URL — just don't add an allow entry */
  }
  // The sandbox dev server is long-lived and isn't restarted on change, so refresh the live
  // rules periodically — a dependency flagged after boot is then enforced without a restart.
  // Production relies on a redeploy (which re-fetches at boot), so refresh stays off there.
  const refreshMs = process.env.PATCHSTACK_ENVIRONMENT === "sandbox" ? 15000 : 0;
  const common = { mode, egress: true, allowHosts, refreshMs };
  return createProtection(
    siteUuid
      ? { ...common, siteUuid, rules: fallbackRules as never, cacheDir: ".patchstack" } // live per-site rules; bundled = offline fallback
      : token
        ? { ...common, token, cacheDir: ".patchstack" } // live per-site WAF rules from the Patchstack API (cached)
        : { ...common, rules: fallbackRules as never }, // demo fallback until a site UUID / token is set
  );
}

// Request-middleware path: the browser tunnels its direct Supabase calls here.
let _handle: ((request: Request) => Promise<Response>) | undefined;
export async function handleGuardRequest(request: Request): Promise<Response> {
  if (!_handle) {
    _handle = createSupabaseGuard({
      protection: await getProtection(),
      supabaseUrl: process.env.SUPABASE_URL,
    });
  }
  return _handle(request);
}

// Function-middleware path: inspect a server function's decoded args before the handler runs.
// Returns a block receipt (throw on it to abort the call) or null to allow.
let _inspect: ((data: unknown) => Promise<{ rule?: string; message: string } | null>) | undefined;
export async function inspectServerFn(data: unknown): Promise<{ rule?: string; message: string } | null> {
  if (!_inspect) {
    _inspect = createServerFnGuard({ protection: await getProtection() });
  }
  return _inspect(data);
}

// Response phase: redact leaked secrets / PII (private keys, cloud keys, JWTs, DB URLs, …) from an
// outgoing response before it leaves the server. Applied to the SSR / non-tunnel response in
// src/start.ts (the browser→Supabase tunnel screens its own forwarded response). Only acts on a
// web Response (text/JSON/HTML) — anything else, or any error, passes through untouched (fail-open,
// never breaks a response).
// `request` is optional but should be passed wherever it is available: response rules can be scoped to a
// route or a method, and the engine can only apply that scope if it is given the request the response
// belongs to. Without it a scoped response rule is delivered, counted as protection, and matches nothing.
export async function screenResponse<T>(response: T, request?: Request): Promise<T> {
  try {
    if (!(response instanceof Response)) return response;
    const protection = await getProtection();
    return (protection.screenResponse ? await protection.screenResponse(response, request) : response) as T;
  } catch {
    return response; // fail open
  }
}

// Optional route-level WAF: evaluate the request-phase rules on EVERY incoming request (not just
// the Supabase tunnel / server functions) and return a 403 on a match. Off unless the app sets
// PATCHSTACK_ROUTE_WAF=1 — enabling it runs the request rules on all traffic, which is a classic
// WAF false-positive surface, so it is opt-in. `request.clone()` so the app can still read the body.
let _reqGuard: ((request: Request) => Promise<Response | null>) | undefined;
export async function guardRequest(request: Request): Promise<Response | null> {
  try {
    if (!_reqGuard) _reqGuard = (await getProtection()).fetchGuard();
    return await _reqGuard(request.clone());
  } catch {
    return null; // fail open
  }
}
