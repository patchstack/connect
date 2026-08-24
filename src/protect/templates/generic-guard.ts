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

let _protection: Promise<Awaited<ReturnType<typeof createProtection>>> | undefined;

/**
 * One protection policy, memoized on the IN-FLIGHT promise rather than the resolved value.
 *
 * A cold start takes several concurrent requests. Caching only the finished value lets each of them see an
 * empty cache and start its own build — several rule fetches, several refresh loops, and several policies
 * where the app is meant to have one. Holding the promise means the first request starts it and the rest
 * await the same one.
 *
 * A failed build is not cached: the slot is cleared so the next request tries again rather than inheriting
 * one bad boot for the life of the process.
 */
export async function getProtection() {
  if (!_protection) {
    _protection = buildProtection().catch((err) => {
      _protection = undefined; // don't cache a failed boot
      throw err;
    });
  }

  return _protection;
}

async function buildProtection() {
  const mode = process.env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block";
  const token = process.env.PATCHSTACK_WAF_TOKEN;
  const siteUuid = PS_SITE_UUID.startsWith("__") ? process.env.PATCHSTACK_SITE_UUID : PS_SITE_UUID;
  // The sandbox dev server is long-lived and isn't restarted on change, so refresh the live
  // rules periodically — a dependency flagged after boot is then enforced without a restart.
  // Production relies on a redeploy (which re-fetches at boot), so refresh stays off there.
  const refreshMs = process.env.PATCHSTACK_ENVIRONMENT === "sandbox" ? 15000 : 0;
  const common = { mode, egress: true, refreshMs } as const;
  return createProtection(
    siteUuid
      ? { ...common, siteUuid, rules: fallbackRules as never, cacheDir: ".patchstack" }
      : token
        ? { ...common, token, cacheDir: ".patchstack" }
        : { ...common, rules: fallbackRules as never },
  );
}

// --- Web Fetch (Cloudflare Workers, Bun, Deno, Hono, Next edge, TanStack server.ts) ---------
// Wrap your fetch handler:  export default { fetch: protectFetch(originalFetch) }
export function protectFetch<H extends (request: Request, ...rest: unknown[]) => unknown>(handler: H): H {
  return (async (request: Request, ...rest: unknown[]) => {
    const protection = await getProtection();
    const blocked = await protection.fetchGuard()(request);
    if (blocked) return blocked;
    // Response rules can be scoped to a route or a method, and the engine can only apply that scope if it is
    // given the request the response belongs to. Passed through here for that reason: without it a scoped
    // response rule is delivered, counted as protection, and never matches anything.
    return protection.screenResponse(await handler(request, ...rest) as Response, request);
  }) as H;
}

// --- Node / Express -------------------------------------------------------------------------
// app.use(patchstackMiddleware) — register it before any body parser and before your routes. This guard
// reads the request stream itself and exposes what it read as req.body, so a parser is not also needed.
export function patchstackMiddleware(req: unknown, res: unknown, next: (err?: unknown) => void) {
  getProtection()
    .then((protection) => (protection.node() as (a: unknown, b: unknown, c: (e?: unknown) => void) => void)(req, res, next))
    .catch(() => next()); // fail open
}
