// Patchstack runtime guard for Nuxt / Nitro — server middleware. Managed by `patchstack-connect protect`.
// Runs the request-phase WAF (+ egress SSRF) on every request. Nuxt runs each file in
// `server/middleware/` as independent middleware, so this file coexists with your own.
import { defineEventHandler, getRequestURL, readRawBody, setResponseStatus, setResponseHeader } from "h3";
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
  const mode = process.env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block";
  const token = process.env.PATCHSTACK_WAF_TOKEN;
  const siteUuid = PS_SITE_UUID.startsWith("__") ? process.env.PATCHSTACK_SITE_UUID : PS_SITE_UUID;
  const common = { mode, egress: true } as const;
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
// #region patchstack-nuxt (managed by patchstack-connect protect — do not edit)
export default defineEventHandler(async (event) => {
  const protection = await getProtection().catch(psStepAside);
  if (!protection) return; // Nitro continues to the route
  const method = event.method ?? "GET";
  // readRawBody caches on the event, so your route handlers can still read the body.
  const body = method !== "GET" && method !== "HEAD" ? await readRawBody(event) : undefined;
  const blocked = await protection
    .fetchGuard()(new Request(getRequestURL(event), { method, headers: event.headers, body: body ?? undefined }));
  if (blocked) {
    setResponseStatus(event, blocked.status);
    const contentType = blocked.headers.get("content-type");
    if (contentType) setResponseHeader(event, "content-type", contentType);
    return blocked.text(); // 403 — blocked before it reaches your route
  }
});
// #endregion patchstack-nuxt
