// Patchstack runtime guard for Nuxt / Nitro — server middleware. Managed by `patchstack-connect protect`.
// Runs the request-phase WAF (+ egress SSRF) on every request. Nuxt runs each file in
// `server/middleware/` as independent middleware, so this file coexists with your own.
import { defineEventHandler, getRequestURL, readRawBody, setResponseStatus, setResponseHeader } from "h3";
import { createProtection } from "@patchstack/connect/protect";
import fallbackRules from "./patchstack.rules.json";

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

// #region patchstack-nuxt (managed by patchstack-connect protect — do not edit)
export default defineEventHandler(async (event) => {
  const protection = await getProtection();
  const method = event.method ?? "GET";
  // readRawBody caches on the event, so your route handlers can still read the body.
  const body = method !== "GET" && method !== "HEAD" ? await readRawBody(event) : undefined;
  const blocked = await protection
    .fetchGuard()(new Request(getRequestURL(event), { method, headers: event.headers, body: body ?? undefined }));
  if (blocked) {
    setResponseStatus(event, blocked.status);
    const contentType = blocked.headers.get("content-type");
    if (contentType) setResponseHeader(event, "content-type", contentType);
    return blocked.text(); // 403 — blocked before it reaches your route
  }
});
// #endregion patchstack-nuxt
