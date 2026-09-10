// Patchstack runtime protection — GENERIC guard (framework-agnostic).
//
// Scaffolded by `patchstack-connect protect` when no built-in adapter matched your stack. Wire
// whichever helper below fits your server into your request path (see the plan the CLI printed),
// then run `patchstack-connect protect --check` to confirm it's hooked up. The engine ships inside
// @patchstack/connect — nothing else to install.
import { createProtection, sentinelAnswer, VERIFY_HEADER } from "@patchstack/connect/protect";
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


// A protection that could not be built must not become an app that cannot answer. Each seam below asks
// for one, steps aside when it cannot have one, and leaves the app to carry on unscreened.
// `getProtection` clears its slot on a failed build, so the next request builds again — one bad start
// does not switch protection off for the life of the process.
//
// Only the FIRST failure is reported: enough to know the guard is not screening, without a line per
// request. A later failure is not reported, including one with a different cause.
let psUnavailable = false;
function psStepAside(err: unknown) {
  if (!psUnavailable) {
    psUnavailable = true;
    console.warn(
      "[patchstack] protection is unavailable; traffic may pass through unscreened until a later attempt succeeds. Reported once per process. Cause: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  return null;
}
// --- Web Fetch (Cloudflare Workers, Bun, Deno, Hono, Next edge, TanStack server.ts) ---------
// Wrap your fetch handler:  export default { fetch: protectFetch(originalFetch) }
export function protectFetch<H extends (request: Request, ...rest: unknown[]) => unknown>(handler: H): H {
  return (async (request: Request, ...rest: unknown[]) => {
    // `protect --check --runtime` asks whether a request actually reaches this seam. The answer is
    // derived from a challenge the verifying process mints per run, which rules out an app matching it
    // by accident, and there is nothing to answer unless that process started this one. Without a
    // challenge in the environment this is a header read.
    const answered = await sentinelAnswer(request.headers.get(VERIFY_HEADER));
    if (answered) return new Response(answered, { status: 200, headers: { "content-type": "text/plain" } });
    const protection = await getProtection().catch(psStepAside);
    // The handler, and nothing around it: an exception the app throws is the app's, not a protection
    // failure, and must not be read as one or answered twice.
    if (!protection) return handler(request, ...rest);
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
  // `next` is wrapped so it can run at most once, whatever happens. That is what makes the two
  // handlers below safe: a rejection handler passed to `then` sees only a failed build, the trailing
  // one sees whatever the guard or the app's own chain threw and reports it — and neither can pass a
  // request on that was already passed on, nor leave one that never was.
  let passedOn = false;
  const carryOn = (err?: unknown) => {
    if (passedOn) return;
    passedOn = true;
    next(err);
  };
  // `protect --check --runtime` asks whether a request actually reaches this seam. Answered here,
  // before the protection is asked for and before the request is passed on, so no handler of the app's
  // ever sees a verification request. The answer is derived from a challenge the verifying process mints
  // per run, which rules out an app matching it by accident; without a challenge in the environment
  // there is nothing to answer and the request is screened as normal.
  const screen = () => {
    getProtection().then(
      (protection) => (protection.node() as (a: unknown, b: unknown, c: (e?: unknown) => void) => void)(req, res, carryOn),
      (err) => {
        psStepAside(err);
        carryOn();
      },
    ).catch((err) => {
      // Not a failed build: the guard, or the app's own chain, threw after this point. Reported, and the
      // request is carried on only if it never was — an error here must not take the process down and
      // must not answer twice.
      psStepAside(err);
      carryOn();
    });
  };

  // The two shapes this seam touches, named rather than asserted wholesale: a request whose headers it
  // reads, and a response it answers on.
  const inbound = req as { headers?: Record<string, unknown> };
  const outbound = res as { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void };

  sentinelAnswer(inbound.headers?.[VERIFY_HEADER]).then((answered) => {
    if (answered) {
      outbound.statusCode = 200;
      outbound.setHeader("content-type", "text/plain");
      outbound.end(answered);

      return;
    }
    screen();
  }, screen);
}
