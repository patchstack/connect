// Patchstack runtime guard for CommonJS Express apps. Managed by `patchstack-connect protect`.
const { createProtection, sentinelAnswer, VERIFY_HEADER } = require("@patchstack/connect/protect");
// The fallback bundle is optional at RUNTIME. This file is imported on the app's own module path, so a
// throw here is the app failing to boot rather than protection failing open — and a rules file can be
// absent for ordinary reasons: a bundler that copied no JSON, a partial deploy, a half-written edit.
// Without it the guard holds no local bundle, and says so. Its other two rule sources are untouched:
// live rules for a configured site, and the engine's own compiled response/egress policy.
let fallbackRules;
try {
  fallbackRules = require("./rules.json");
} catch (err) {
  console.warn("[patchstack] ./rules.json was not read (" + err.message + "); the guard holds no local rules");
}

const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";
let protection;

async function getProtection() {
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
  // The sandbox dev server is long-lived and isn't restarted on change, so refresh the live
  // rules periodically — a dependency flagged after boot is then enforced without a restart.
  // Production relies on a redeploy (which re-fetches at boot), so refresh stays off there.
  const refreshMs = process.env.PATCHSTACK_ENVIRONMENT === "sandbox" ? 15000 : 0;
  const common = { mode, egress: true, refreshMs };
  return createProtection(
    siteUuid
      ? { ...common, siteUuid, rules: fallbackRules, cacheDir: ".patchstack" }
      : token
        ? { ...common, token, cacheDir: ".patchstack" }
        : { ...common, rules: fallbackRules },
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
function psStepAside(err) {
  if (!psUnavailable) {
    psUnavailable = true;
    console.warn(
      "[patchstack] protection is unavailable; traffic may pass through unscreened until a later attempt succeeds. Reported once per process. Cause: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  return null;
}
function patchstackMiddleware(req, res, next) {
  // `next` is wrapped so it can run at most once, whatever happens. That is what makes the two
  // handlers below safe: a rejection handler passed to `then` sees only a failed build, the trailing
  // one sees whatever the guard or the app's own chain threw and reports it — and neither can pass a
  // request on that was already passed on, nor leave one that never was.
  let passedOn = false;
  const carryOn = (err) => {
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
      (active) => active.express()(req, res, carryOn),
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

  sentinelAnswer(req.headers?.[VERIFY_HEADER]).then((answered) => {
    if (answered) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end(answered);

      return;
    }
    screen();
  }, screen);
}

module.exports = { patchstackMiddleware };
