// Patchstack runtime guard for Fastify — plugin. Managed by `patchstack-connect protect`.
// Register it once (`app.register(patchstackFastify)`); it adds a preHandler hook that runs the
// request-phase WAF (+ egress SSRF) on every request. Fastify's request/reply aren't Web-Fetch
// shaped, so we reconstruct a Request from the parsed fastify request and run the fetch guard.
import { createProtection } from "@patchstack/connect/protect";
import fallbackRules from "./rules.json";

const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";

let _protection: Awaited<ReturnType<typeof createProtection>> | undefined;
async function getProtection() {
  if (!_protection) {
    const mode = process.env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block";
    const token = process.env.PATCHSTACK_WAF_TOKEN;
    const siteUuid = PS_SITE_UUID.startsWith("__") ? process.env.PATCHSTACK_SITE_UUID : PS_SITE_UUID;
    const common = { mode, egress: true } as const;
    _protection = await createProtection(
      siteUuid
        ? { ...common, siteUuid, rules: fallbackRules as never, cacheDir: ".patchstack" }
        : token
          ? { ...common, token, cacheDir: ".patchstack" }
          : { ...common, rules: fallbackRules as never },
    );
  }
  return _protection;
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
