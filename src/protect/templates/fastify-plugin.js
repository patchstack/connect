// Patchstack runtime guard for ESM Fastify apps. Managed by `patchstack-connect protect`.
// Register once: app.register(patchstackFastify)
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
export async function patchstackFastify(fastify) {
  // Built here, at registration, and NOT only on the first request: building the protection is also
  // what installs egress screening, and an app's startup work makes outbound calls before any request
  // arrives. A failure is swallowed rather than propagated, because registering a plugin must not be
  // able to fail — and the hook asks again, so a build that failed at startup is retried rather than
  // leaving every route unscreened for the life of the process.
  await getProtection().catch(psStepAside);

  fastify.addHook("preHandler", async (request, reply) => {
    // `protect --check --runtime` asks whether a request actually reaches this seam. Answered before
    // the route and before this request's screening — not before the protection was ever asked for,
    // which registration above already did, deliberately, so startup egress is screened. The answer is
    // derived from a challenge the verifying process mints per run, which rules out an app matching it
    // by accident; without a challenge in the environment this is a header read.
    const answered = await sentinelAnswer(request.headers?.[VERIFY_HEADER]);
    if (answered) {
      reply.code(200);
      reply.header("content-type", "text/plain");
      reply.send(answered);

      return reply;
    }
    const protection = await getProtection().catch(psStepAside);
    if (!protection) return; // the route answers this request, unscreened
    const guard = protection.fetchGuard();
    const method = (request.method ?? "GET").toUpperCase();
    const host = request.headers?.host ?? "localhost";
    const url = `http://${host}${request.url ?? "/"}`;
    const hasBody = method !== "GET" && method !== "HEAD" && request.body != null;
    const body = hasBody ? (typeof request.body === "string" ? request.body : JSON.stringify(request.body)) : undefined;
    const blocked = await guard(new Request(url, { method, headers: request.headers, body }));
    if (blocked) {
      const contentType = blocked.headers.get("content-type");
      reply.code(blocked.status);
      if (contentType) reply.header("content-type", contentType);
      reply.send(await blocked.text());
      return reply;
    }
  });
}

// Fastify ENCAPSULATES a registered plugin: hooks added inside one apply to that plugin's context and
// its children, and to nothing else. Registered as an ordinary plugin, this guard would screen nothing
// on the root instance and nothing in sibling route plugins — which is most of an application, and it
// would look installed the whole time.
//
// This is the marker `fastify-plugin` sets, and the mechanism Fastify documents for opting out: with it,
// `register` runs the function against the ROOT instance instead of a child context, so the hook applies
// to every route. Set here rather than pulling in `fastify-plugin` so an installed app gains no
// dependency it did not already have.
patchstackFastify[Symbol.for("skip-override")] = true;
