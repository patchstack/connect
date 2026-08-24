// Patchstack runtime protection — GENERIC guard (ESM). Managed by `patchstack-connect protect`.
// Wire whichever helper fits your server into your request path, then run `protect --check`.
import { readFileSync } from "node:fs";
import { createProtection } from "@patchstack/connect/protect";

const fallbackRules = JSON.parse(readFileSync(new URL("./rules.json", import.meta.url), "utf8"));
const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";
let protection;

export async function getProtection() {
  if (!protection) {
    // Memoized on the in-flight promise, not the resolved value: a cold start takes several
    // concurrent requests, and caching only the finished value lets each of them build its own
    // policy — several rule fetches and several refresh loops where the app should have one.
    protection = buildProtection().catch((err) => {
      protection = undefined; // don't cache a failed boot
      throw err;
    });
  }

  return protection;
}

async function buildProtection() {
  const mode = process.env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block";
  const token = process.env.PATCHSTACK_WAF_TOKEN;
  const siteUuid = PS_SITE_UUID.startsWith("__") ? process.env.PATCHSTACK_SITE_UUID : PS_SITE_UUID;
  const common = { mode, egress: true };
  return createProtection(
    siteUuid
      ? { ...common, siteUuid, rules: fallbackRules, cacheDir: ".patchstack" }
      : token
        ? { ...common, token, cacheDir: ".patchstack" }
        : { ...common, rules: fallbackRules },
  );
}

// Web-Fetch: export default { fetch: protectFetch(originalFetch) }
export function protectFetch(handler) {
  return async (request, ...rest) => {
    const active = await getProtection();
    const blocked = await active.fetchGuard()(request);
    if (blocked) return blocked;
    // Response rules can be scoped to a route or a method, and the engine can only apply that scope if it is
    // given the request the response belongs to. Passed through here for that reason: without it a scoped
    // response rule is delivered, counted as protection, and never matches anything.
    return active.screenResponse(await handler(request, ...rest), request);
  };
}

// Node / Connect: app.use(patchstackMiddleware) — before any body parser. This guard reads the request
// stream itself and exposes what it read as req.body, so a parser is not also needed.
export function patchstackMiddleware(req, res, next) {
  getProtection()
    .then((active) => active.node()(req, res, next))
    .catch(() => next()); // fail open
}
