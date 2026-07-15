// Patchstack runtime guard for Express. Managed by `patchstack-connect protect`.
// Register after body parsing and before routes: app.use(patchstackMiddleware).
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

export function patchstackMiddleware(req: unknown, res: unknown, next: (err?: unknown) => void) {
  getProtection()
    .then((protection) =>
      (protection.express() as (a: unknown, b: unknown, c: (e?: unknown) => void) => void)(req, res, next),
    )
    .catch(() => next());
}
