// Patchstack auto-guard — installed automatically by "add Patchstack"; the vibe coder never
// touches this. It runs in the app's own server (the Cloudflare Worker). The patched Supabase
// client tunnels every browser data call here; we inspect the payload against the rules, then
// either block it (virtual patch) or forward it to real Supabase.
import { evaluate } from "./engine.js";
import rulesData from "./rules.json";
import { manifest } from "./manifest.js";

export const GUARD_PATH = "/_patchstack/guard";

// Headers that must not be copied verbatim when we re-emit the upstream response.
const HOP_BY_HOP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

function mode(): "dry-run" | "block" {
  return process.env.PATCHSTACK_MODE === "block" ? "block" : "dry-run";
}

export async function handleGuardRequest(request: Request): Promise<Response> {
  const target = request.headers.get("x-ps-target");
  if (!target) return new Response("patchstack: missing x-ps-target", { status: 400 });

  // SSRF guard: the client names the target, but we only ever forward to the app's own
  // Supabase project (origin known server-side). Anything else — internal hosts, cloud
  // metadata, a different scheme — is rejected before we make any outbound request.
  const supabaseUrl = process.env.SUPABASE_URL;
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response("patchstack: invalid target", { status: 400 });
  }
  if (!supabaseUrl || targetUrl.protocol !== "https:" || targetUrl.origin !== new URL(supabaseUrl).origin) {
    return new Response("patchstack: target not allowed", { status: 403 });
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const bodyText = hasBody ? await request.text() : "";

  let record: Record<string, unknown> = {};
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      record = Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed;
    } catch {
      // not JSON — leave record empty; the rule simply won't match
    }
  }

  const ctx = {
    method: request.method,
    url: target,
    headers: Object.fromEntries(request.headers),
    // expose the record under a few shapes so rule parameters like "insert.title" resolve
    body: { ...record, insert: record, update: record },
    ip: request.headers.get("x-forwarded-for") ?? "",
  };

  const t0 = performance.now();
  const verdict = evaluate(ctx, (rulesData as { firewall: unknown[] }).firewall, manifest);
  const latencyMs = Math.round((performance.now() - t0) * 100) / 100;

  // Always log the flag (this is the "dry-run sees it too" behavior).
  const decision = verdict.matched ? `MATCH ${verdict.rule_id}` : "clean";
  console.log(`[patchstack] ${request.method} ${new URL(target).pathname} -> ${decision} · mode=${mode()}`);

  if (verdict.matched && mode() === "block") {
    const receipt = {
      blocked: true,
      rule_id: verdict.rule_id,
      vulnerability_id: verdict.vulnerability_id,
      package: verdict.package,
      version: verdict.version,
      matched_conditions: verdict.explain,
      latency_ms: latencyMs,
    };
    console.log("[patchstack] BLOCKED", JSON.stringify(receipt));
    return new Response(JSON.stringify(receipt), {
      status: 403,
      headers: { "content-type": "application/json", "x-patchstack": "blocked" },
    });
  }

  // Forward to real Supabase, server-side.
  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.delete("x-ps-target");
  forwardHeaders.delete("host");
  const upstream = await fetch(target, {
    method: request.method,
    headers: forwardHeaders,
    body: hasBody ? bodyText : undefined,
    redirect: "manual",
  });

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders.set(key, value);
  });
  const buf = await upstream.arrayBuffer();
  return new Response(buf, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders });
}
