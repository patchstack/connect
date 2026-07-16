// Patchstack runtime guard for CommonJS Express apps WITHOUT a body parser. Managed by `patchstack-connect protect`.
// Register before your routes: app.use(patchstackMiddleware). This variant buffers the request body
// itself (no express.json()/body-parser required) and re-exposes req.body downstream.
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

function patchstackMiddleware(req, res, next) {
  getProtection()
    .then((active) => active.node()(req, res, next))
    .catch(() => next());
}

module.exports = { patchstackMiddleware };
