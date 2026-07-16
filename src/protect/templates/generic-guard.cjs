// Patchstack runtime protection — GENERIC guard (CommonJS). Managed by `patchstack-connect protect`.
// Wire whichever helper fits your server into your request path, then run `protect --check`.
const { createProtection } = require("@patchstack/connect/protect");
const fallbackRules = require("./rules.json");

const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";
let protection;

async function getProtection() {
  if (!protection) {
    const mode = process.env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block";
    const token = process.env.PATCHSTACK_WAF_TOKEN;
    const siteUuid = PS_SITE_UUID.startsWith("__") ? process.env.PATCHSTACK_SITE_UUID : PS_SITE_UUID;
    const common = { mode, egress: true };
    protection = await createProtection(
      siteUuid
        ? { ...common, siteUuid, rules: fallbackRules, cacheDir: ".patchstack" }
        : token
          ? { ...common, token, cacheDir: ".patchstack" }
          : { ...common, rules: fallbackRules },
    );
  }
  return protection;
}

function protectFetch(handler) {
  return async (request, ...rest) => {
    const active = await getProtection();
    const blocked = await active.fetchGuard()(request);
    if (blocked) return blocked;
    return active.screenResponse(await handler(request, ...rest));
  };
}

function patchstackMiddleware(req, res, next) {
  getProtection()
    .then((active) => active.node()(req, res, next))
    .catch(() => next()); // fail open
}

module.exports = { getProtection, protectFetch, patchstackMiddleware };
