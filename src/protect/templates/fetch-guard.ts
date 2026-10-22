// Server-only Fetch guard for bundled applications. Never import this module into client code.
import { createProtection, sentinelAnswer, VERIFY_HEADER } from "@patchstack/connect/protect";
import fallbackRules from "./rules.json";

const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";
type Protection = Awaited<ReturnType<typeof createProtection>>;
const policies = new WeakMap<object, Promise<Protection>>();
const emptyEnvironment = {};
let warned = false;

function environment(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && ["PATCHSTACK_API_KEY", "PATCHSTACK_SITE_UUID", "PATCHSTACK_PULSE_AUTH"].some(key => key in value)) {
    return value as Record<string, unknown>;
  }
  return typeof process === "undefined" ? emptyEnvironment : process.env;
}

async function getProtection(bindings: unknown) {
  const env = environment(bindings);
  let pending = policies.get(env);
  if (!pending) {
    const value = (key: string) => typeof env[key] === "string" ? env[key] as string : undefined;
    pending = createProtection({
      siteUuid: PS_SITE_UUID.startsWith("__") ? value("PATCHSTACK_SITE_UUID") : PS_SITE_UUID,
      apiKey: value("PATCHSTACK_API_KEY"),
      pulseAuth: value("PATCHSTACK_PULSE_AUTH") ?? value("PATCHSTACK_API_KEY"),
      mode: value("PATCHSTACK_MODE") === "dry-run" ? "dry-run" : "block",
      rules: fallbackRules as never,
      cacheDir: ".patchstack",
      refreshMs: value("PATCHSTACK_ENVIRONMENT") === "sandbox" ? 15000 : 300000,
      egress: true,
    }).catch(error => { policies.delete(env); throw error; });
    policies.set(env, pending);
  }
  return pending.catch(error => {
    if (!warned) {
      warned = true;
      console.warn("[patchstack] protection is unavailable; traffic may pass through unscreened until a later attempt succeeds.", error instanceof Error ? error.message : String(error));
    }
    return null;
  });
}

export function protectFetch<Args extends unknown[]>(handler: (request: Request, ...args: Args) => Response | Promise<Response>) {
  return async function(this: unknown, request: Request, ...args: Args): Promise<Response> {
    const answered = await sentinelAnswer(request.headers.get(VERIFY_HEADER));
    if (answered) return new Response(answered, { headers: { "content-type": "text/plain" } });
    const protection = await getProtection(args[0]);
    // Only initialization fails open here. Application failures propagate without repeating the handler.
    return protection ? protection.fetch(handler).call(this, request, ...args) : handler.call(this, request, ...args);
  };
}
