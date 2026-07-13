// Patchstack runtime protection — installed by `patchstack-connect protect`; the vibe coder
// never touches this. It runs in the app's own server (e.g. the Cloudflare Worker). The
// generated Supabase client is patched to tunnel every browser data call here, so Patchstack
// sees the traffic; this guard runs the protection policy and forwards clean requests on.
//
// Always-on by default (blocks). Rules come from the Patchstack API per-site (cached); the
// bundled rules.json is only a fallback for before a token is configured. The engine ships
// inside @patchstack/connect — nothing else to install.
import { createProtection, createSupabaseGuard, GUARD_PATH } from "@patchstack/connect/protect";
import fallbackRules from "./rules.json";

export { GUARD_PATH };

let _handle: ((request: Request) => Promise<Response>) | undefined;

async function getHandler() {
  if (!_handle) {
    // Always-on: block by default. An explicit PATCHSTACK_MODE=dry-run downgrades to log-only.
    const mode = process.env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block";
    const token = process.env.PATCHSTACK_WAF_TOKEN;
    const protection = await createProtection(
      token
        ? { token, mode, cacheDir: ".patchstack" } // live per-site rules from the Patchstack API (cached)
        : { rules: fallbackRules as never, mode }, // demo fallback until a token is set
    );
    _handle = createSupabaseGuard({ protection, supabaseUrl: process.env.SUPABASE_URL });
  }
  return _handle;
}

export async function handleGuardRequest(request: Request): Promise<Response> {
  return (await getHandler())(request);
}
