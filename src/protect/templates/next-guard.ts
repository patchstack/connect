// Server-only helpers for Next.js middleware and App Router handlers.
import { createProtection } from "@patchstack/connect/protect";
import fallbackRules from "./patchstack.rules.json";

const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";
type Protection = Awaited<ReturnType<typeof createProtection>>;
let _protection: Promise<Protection> | undefined;
let warned = false;

async function getProtection() {
  if (!_protection) {
    _protection = buildProtection().catch((error) => {
      _protection = undefined;
      throw error;
    });
  }
  return _protection;
}

async function buildProtection() {
  const mode = process.env.PATCHSTACK_MODE === "dry-run" ? "dry-run" : "block";
  const siteUuid = PS_SITE_UUID.startsWith("__") ? process.env.PATCHSTACK_SITE_UUID : PS_SITE_UUID;
  const token = process.env.PATCHSTACK_WAF_TOKEN;
  const common = { mode, egress: true } as const;
  return createProtection(
    siteUuid
      ? { ...common, siteUuid, rules: fallbackRules as never, cacheDir: ".patchstack" }
      : token
        ? { ...common, token, cacheDir: ".patchstack" }
        : { ...common, rules: fallbackRules as never },
  );
}

export async function getPatchstackProtection() {
  return getProtection().catch((error: unknown) => {
    if (!warned) {
      warned = true;
      console.warn(
        "[patchstack] protection is unavailable; traffic may pass through unscreened until a later attempt succeeds. Reported once per process. Cause: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    return null;
  });
}

// The handler's expression is evaluated once; its rejection remains the application's error.
export async function screenPatchstackResponse(
  response: Response | Promise<Response>,
  request: Request,
  protection: Protection | null,
): Promise<Response> {
  return protection ? protection.screenResponse(await response, request) : response;
}
