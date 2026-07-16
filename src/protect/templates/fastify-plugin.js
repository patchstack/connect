// Patchstack runtime guard for ESM Fastify apps. Managed by `patchstack-connect protect`.
// Register once: app.register(patchstackFastify)
import { readFileSync } from "node:fs";
import { createProtection } from "@patchstack/connect/protect";

const fallbackRules = JSON.parse(readFileSync(new URL("./rules.json", import.meta.url), "utf8"));
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
