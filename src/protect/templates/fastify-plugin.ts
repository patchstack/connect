// Patchstack runtime guard for Fastify — plugin. Managed by `patchstack-connect protect`.
// Register it once (`app.register(patchstackFastify)`); it adds a preHandler hook that runs the
// request-phase WAF (+ egress SSRF) on every request. Fastify's request/reply aren't Web-Fetch
// shaped, so we reconstruct a Request from the parsed fastify request and run the fetch guard.
import { createProtection } from "@patchstack/connect/protect";
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

// #region patchstack-fastify (managed by patchstack-connect protect — do not edit)
export async function patchstackFastify(fastify: any) {
  const protection = await getProtection();
  const guard = protection.fetchGuard();
  fastify.addHook("preHandler", async (request: any, reply: any) => {
    const method = (request.method ?? "GET").toUpperCase();
    const host = request.headers?.host ?? "localhost";
    const url = `http://${host}${request.url ?? "/"}`;
    const hasBody = method !== "GET" && method !== "HEAD" && request.body != null;
    const body = hasBody ? (typeof request.body === "string" ? request.body : JSON.stringify(request.body)) : undefined;
    const blocked = await guard(new Request(url, { method, headers: request.headers as HeadersInit, body }));
    if (blocked) {
      const contentType = blocked.headers.get("content-type");
      reply.code(blocked.status);
      if (contentType) reply.header("content-type", contentType);
      reply.send(await blocked.text());
      return reply; // stop the request here
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
