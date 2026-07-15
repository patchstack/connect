// Patchstack runtime guard for Next.js — edge middleware. Managed by `patchstack-connect protect`.
// Runs the request-phase WAF (+ egress SSRF) on every request before it reaches your route.
// Note: response-body redaction isn't available in Next middleware (it runs before the response);
// wire the connect runtime in your route handlers if you also need response screening there.
import { createProtection } from "@patchstack/connect/protect";
import fallbackRules from "./patchstack.rules.json";

let _protection: Awaited<ReturnType<typeof createProtection>> | undefined;
async function getProtection() {
  if (!_protection) {
    const mode = process.env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block";
    const token = process.env.PATCHSTACK_WAF_TOKEN;
    const siteUuid = process.env.PATCHSTACK_SITE_UUID;
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

// #region patchstack-next (managed by patchstack-connect protect — do not edit)
export async function middleware(request: Request) {
  const protection = await getProtection();
  const blocked = await protection.fetchGuard()(request);
  if (blocked) return blocked; // 403 — blocked before it reaches your route
  // otherwise fall through (Next continues to the route)
}

export const config = { matcher: "/:path*" };
// #endregion patchstack-next
