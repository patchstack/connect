// Patchstack runtime protection — GENERIC guard (ESM). Managed by `patchstack-connect protect`.
// Wire whichever helper fits your server into your request path, then run `protect --check`.
import { readFileSync } from "node:fs";
import { createProtection, sentinelAnswer, VERIFY_HEADER } from "@patchstack/connect/protect";

// The fallback bundle is optional at RUNTIME. This file is imported on the app's own module path, so a
// throw here is the app failing to boot rather than protection failing open — and a rules file can be
// absent for ordinary reasons: a bundler that copied no JSON, a partial deploy, a half-written edit.
// Without it the guard holds no local bundle, and says so. Its other two rule sources are untouched:
// live rules for a configured site, and the engine's own compiled response/egress policy.
let fallbackRules;
try {
  fallbackRules = JSON.parse(readFileSync(new URL("./rules.json", import.meta.url), "utf8"));
} catch (err) {
  console.warn("[patchstack] ./rules.json was not read (" + err.message + "); the guard holds no local rules");
}
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
// Web-Fetch: export default { fetch: protectFetch(originalFetch) }
export function protectFetch(handler) {
  return async (request, ...rest) => {
    // `protect --check --runtime` asks whether a request actually reaches this seam. The answer is
    // derived from a challenge the verifying process mints per run, which rules out an app matching it
    // by accident, and there is nothing to answer unless that process started this one. Without a
    // challenge in the environment this is a header read.
    const answered = await sentinelAnswer(request.headers.get(VERIFY_HEADER));
    if (answered) return new Response(answered, { status: 200, headers: { "content-type": "text/plain" } });
    const active = await getProtection().catch(psStepAside);
    // The handler, and nothing around it: an exception the app throws is the app's, not a protection
    // failure, and must not be read as one or answered twice.
    if (!active) return handler(request, ...rest);
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
      (active) => active.node()(req, res, carryOn),
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
