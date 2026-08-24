// Patchstack runtime guard for ESM Fastify apps. Managed by `patchstack-connect protect`.
// Register once: app.register(patchstackFastify)
import { readFileSync } from "node:fs";
import { createProtection } from "@patchstack/connect/protect";

const fallbackRules = JSON.parse(readFileSync(new URL("./rules.json", import.meta.url), "utf8"));
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

export async function patchstackFastify(fastify) {
  const protection = await getProtection();
  const guard = protection.fetchGuard();
  fastify.addHook("preHandler", async (request, reply) => {
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
