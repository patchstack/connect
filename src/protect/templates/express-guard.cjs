// Patchstack runtime guard for CommonJS Express apps. Managed by `patchstack-connect protect`.
const { createProtection } = require("@patchstack/connect/protect");
const fallbackRules = require("./rules.json");

const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";
let protection;

async function getProtection() {
  if (!protection) {
    const mode = process.env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block";
    const token = process.env.PATCHSTACK_WAF_TOKEN;
    const siteUuid = PS_SITE_UUID.startsWith("__") ? process.env.PATCHSTACK_SITE_UUID : PS_SITE_UUID;
    // The sandbox dev server is long-lived and isn't restarted on change, so refresh the live
    // rules periodically — a dependency flagged after boot is then enforced without a restart.
    // Production relies on a redeploy (which re-fetches at boot), so refresh stays off there.
    const refreshMs = process.env.PATCHSTACK_ENVIRONMENT === "sandbox" ? 15000 : 0;
    const common = { mode, egress: true, refreshMs };
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

function patchstackMiddleware(req, res, next) {
  getProtection()
    .then((active) => active.express()(req, res, next))
    .catch(() => next());
}

module.exports = { patchstackMiddleware };
