// Patchstack runtime guard for Fastify — plugin. Managed by `patchstack-connect protect`.
// Register it once (`app.register(patchstackFastify)`); it adds a preHandler hook that runs the
// request-phase WAF (+ egress SSRF) and filters buffered onSend output. Fastify's request/reply aren't Web-Fetch
// shaped, so we reconstruct a Request from the parsed fastify request and run the fetch guard.
import { createProtection, sentinelAnswer, VERIFY_HEADER } from "@patchstack/connect/protect";
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

// #region patchstack-fastify (managed by patchstack-connect protect — do not edit)

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
export async function patchstackFastify(fastify: any) {
  // Built here, at registration, and NOT only on the first request: building the protection is also
  // what installs egress screening, and an app's startup work makes outbound calls before any request
  // arrives. A failure is swallowed rather than propagated, because registering a plugin must not be
  // able to fail — and the hook asks again, so a build that failed at startup is retried rather than
  // leaving every route unscreened for the life of the process.
  await getProtection().catch(psStepAside);

  fastify.addHook("preHandler", async (request: any, reply: any) => {
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
    let blocked;
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      }
      const parsed = hasBody && typeof request.body === "object" && !Buffer.isBuffer(request.body);
      const body = hasBody ? (parsed ? JSON.stringify(request.body) : request.body) : undefined;
      // Fastify already parsed form fields. Screen that object as JSON, not JSON mislabeled as a form.
      // Only the screening copy changes; the route keeps its original body, headers and raw stream.
      if (parsed) headers.set("content-type", "application/json");
      headers.delete("content-length");
      blocked = await guard(new Request(url, { method, headers, body }));
    } catch (err) {
      psStepAside(err);
      return;
    }
    if (blocked) {
      const contentType = blocked.headers.get("content-type");
      reply.code(blocked.status);
      if (contentType) reply.header("content-type", contentType);
      reply.send(await blocked.text());
      return reply; // stop the request here
    }
  });

  fastify.addHook("onSend", async (request: any, reply: any, payload: any) => {
    // Do not consume streams, hijacked responses, or bodyless status codes.
    if ((typeof payload !== "string" && !Buffer.isBuffer(payload))
      || request.method === "HEAD" || reply.statusCode < 200 || [204, 205, 304].includes(reply.statusCode)) return payload;
    const protection = await getProtection().catch(psStepAside);
    if (!protection) return payload;
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined) headers.append(name, String(item));
        }
      }
      const original = new Response(typeof payload === "string" ? payload : new Uint8Array(payload).buffer, { status: reply.statusCode, headers });
      const context = new Request(`http://${request.headers?.host ?? "localhost"}${request.url ?? "/"}`, { method: request.method, headers: request.headers });
      const screened = await protection.screenResponse(original, context);
      if (screened === original) return payload;
      const body = Buffer.from(await screened.arrayBuffer());
      reply.code(screened.status);
      for (const name of Object.keys(reply.getHeaders())) reply.removeHeader(name);
      screened.headers.forEach((value, name) => { if (name !== "set-cookie") reply.header(name, value); });
      const cookies = screened.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return body;
    } catch (err) {
      psStepAside(err);
      return payload;
    }
  });
}
// #endregion patchstack-fastify

// Fastify ENCAPSULATES a registered plugin: hooks added inside one apply to that plugin's context and
// its children, and to nothing else. Registered as an ordinary plugin, this guard would screen nothing
// on the root instance and nothing in sibling route plugins — which is most of an application, and it
// would look installed the whole time.
//
// This is the marker `fastify-plugin` sets, and the mechanism Fastify documents for opting out: with it,
// `register` runs the function against the ROOT instance instead of a child context, so the hook applies
// to every route. Set here rather than pulling in `fastify-plugin` so an installed app gains no
// dependency it did not already have.
(patchstackFastify as any)[Symbol.for("skip-override")] = true;
