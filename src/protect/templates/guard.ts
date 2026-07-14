// Patchstack runtime protection — installed by `patchstack-connect protect`; the vibe coder
// never touches this. It runs in the app's own server (e.g. the Cloudflare Worker) and covers
// both ways a Lovable app talks to its database:
//   - browser → Supabase directly: the generated Supabase client is patched to tunnel every call
//     through handleGuardRequest (registered as request middleware in src/start.ts).
//   - browser → TanStack server function → Supabase: inspectServerFn checks the server-fn args
//     (registered as function middleware in src/start.ts) before anything is written.
// Either way Patchstack sees the traffic and runs the same policy.
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
let _protection: Awaited<ReturnType<typeof createProtection>> | undefined;
async function getProtection() {
  if (!_protection) {
    // Always-on: block by default. An explicit PATCHSTACK_MODE=dry-run downgrades to log-only.
    const mode = process.env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block";
    const token = process.env.PATCHSTACK_WAF_TOKEN;
    const siteUuid = PS_SITE_UUID.startsWith("__") ? process.env.PATCHSTACK_SITE_UUID : PS_SITE_UUID;
    _protection = await createProtection(
      siteUuid
        ? { siteUuid, rules: fallbackRules as never, mode, cacheDir: ".patchstack" } // live per-site rules; bundled = offline fallback
        : token
          ? { token, mode, cacheDir: ".patchstack" }
          : { rules: fallbackRules as never, mode },
    );
  }
  return _protection;
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
