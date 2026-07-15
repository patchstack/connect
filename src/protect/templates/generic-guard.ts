// Patchstack runtime protection — GENERIC guard (framework-agnostic).
//
// Scaffolded by `patchstack-connect protect` when no built-in adapter matched your stack. Wire
// whichever helper below fits your server into your request path (see the plan the CLI printed),
// then run `patchstack-connect protect --check` to confirm it's hooked up. The engine ships inside
// @patchstack/connect — nothing else to install.
import { createProtection } from "@patchstack/connect/protect";
import fallbackRules from "./rules.json";

// Baked by `patchstack-connect protect` from .patchstackrc.json when available.
const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";

let _protection: Awaited<ReturnType<typeof createProtection>> | undefined;

/** One memoized protection policy. Rules come from the Patchstack API per-site (cached); the
 *  bundled rules.json is the fallback until a site UUID / token is configured. */
export async function getProtection() {
  if (!_protection) {
    const mode = process.env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block";
    const token = process.env.PATCHSTACK_WAF_TOKEN;
    const siteUuid = PS_SITE_UUID.startsWith("__") ? process.env.PATCHSTACK_SITE_UUID : PS_SITE_UUID;
    const common = { mode, egress: true } as const;
    _protection = await createProtection(
      siteUuid
        ? { ...common, siteUuid, rules: fallbackRules as never, cacheDir: ".patchstack" }
        : token
          ? { ...common, token, cacheDir: ".patchstack" }
          : { ...common, rules: fallbackRules as never },
    );
  }
  return _protection;
}

// --- Web Fetch (Cloudflare Workers, Bun, Deno, Hono, Next edge, TanStack server.ts) ---------
// Wrap your fetch handler:  export default { fetch: protectFetch(originalFetch) }
export function protectFetch<H extends (request: Request, ...rest: unknown[]) => unknown>(handler: H): H {
  return (async (request: Request, ...rest: unknown[]) => {
    const protection = await getProtection();
    const blocked = await protection.fetchGuard()(request);
    if (blocked) return blocked;
    return protection.screenResponse(await handler(request, ...rest) as Response);
  }) as H;
}

// --- Node / Express -------------------------------------------------------------------------
// Add before your routes:  app.use(patchstackMiddleware)
export function patchstackMiddleware(req: unknown, res: unknown, next: (err?: unknown) => void) {
  getProtection()
    .then((protection) => (protection.node() as (a: unknown, b: unknown, c: (e?: unknown) => void) => void)(req, res, next))
    .catch(() => next()); // fail open
}
