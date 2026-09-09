// Patchstack runtime guard for Express. Managed by `patchstack-connect protect`.
// Register after body parsing and before routes: app.use(patchstackMiddleware).
import { createProtection } from "@patchstack/connect/protect";
import fallbackRules from "./rules.json";

const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";
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
  getProtection().then(
    (protection) => (protection.express() as (a: unknown, b: unknown, c: (e?: unknown) => void) => void)(req, res, carryOn),
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
}
