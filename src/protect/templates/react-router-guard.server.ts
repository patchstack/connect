// Patchstack runtime guard for React Router (framework mode) — a root middleware. Managed by
// `patchstack-connect protect`. Runs the request-phase WAF (+ egress SSRF) and screens the response for
// every request. Wired from your root route: `export const middleware = [patchstackRootMiddleware]`.
// The `.server` suffix keeps it out of the browser bundle; never import it into client code.
import { createProtection } from "@patchstack/connect/protect";
import fallbackRules from "./patchstack.rules.json";

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
  const mode = (typeof process === "undefined" ? undefined : process.env.PATCHSTACK_MODE) === "dry-run" ? "dry-run" : "block";
  const token = (typeof process === "undefined" ? undefined : process.env.PATCHSTACK_WAF_TOKEN);
  const siteUuid = PS_SITE_UUID.startsWith("__") ? (typeof process === "undefined" ? undefined : process.env.PATCHSTACK_SITE_UUID) : PS_SITE_UUID;
  const refreshMs = (typeof process === "undefined" ? undefined : process.env.PATCHSTACK_ENVIRONMENT) === "sandbox" ? 15000 : 300000;
  const common = { mode, egress: true, refreshMs } as const;
  return createProtection(
    siteUuid
      ? { ...common, siteUuid, rules: fallbackRules as never, cacheDir: ".patchstack" }
      : token
        ? { ...common, token, cacheDir: ".patchstack" }
        : { ...common, rules: fallbackRules as never },
  );
}

// A protection that could not be built must not become an app that cannot answer: the middleware asks for
// one, steps aside when it cannot have one, and leaves the request to carry on unscreened. `getProtection`
// clears its slot on a failed build, so the next request builds again — one bad start does not switch
// protection off for the life of the process. Only the FIRST failure is reported, to avoid a line per
// request.
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

// #region patchstack-react-router (managed by patchstack-connect protect — do not edit)
/**
 * React Router root middleware. Screens the inbound request (403 before it reaches a loader/action), then
 * the outgoing response. The request body is read from a clone inside the guard, so loaders and actions
 * still receive an intact request.
 *
 * Typed loosely (not against generated route types) so it compiles in any React Router project. Add it in
 * your root route: `export const middleware = [patchstackRootMiddleware];`.
 */
export async function patchstackRootMiddleware(
  { request }: { request: Request },
  next: () => Promise<Response>,
): Promise<Response> {
  const protection = await getProtection().catch(psStepAside);
  if (!protection) return next();
  const blocked = await protection.fetchGuard()(request);
  if (blocked) return blocked; // blocked before it reaches your route
  return protection.screenResponse(await next(), request);
}
// #endregion patchstack-react-router
