// Patchstack runtime guard for Astro — middleware. Managed by `patchstack-connect protect`.
// Runs the request-phase WAF (+ egress SSRF) and screens the response body/headers for every request.
// If you already have middleware, compose them with `sequence()` from "astro:middleware".
import type { MiddlewareHandler } from "astro";
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

// #region patchstack-astro (managed by patchstack-connect protect — do not edit)
export const onRequest: MiddlewareHandler = async (context, next) => {
  const protection = await getProtection();
  const blocked = await protection.fetchGuard()(context.request);
  if (blocked) return blocked; // 403 — blocked before it reaches your route
  return protection.screenResponse(await next());
};
// #endregion patchstack-astro
