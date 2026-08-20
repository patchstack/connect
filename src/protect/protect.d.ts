// Public types for `@patchstack/connect/protect` (the vendored runtime is plain JS, so the
// declarations are hand-authored and shipped alongside dist/protect.js).

export interface RuleBundle {
  firewall: unknown[];
  whitelists: unknown[];
  whitelist_keys: Record<string, unknown>;
  /** From the Pulse rules API when present (`block` = enforce, `dry-run` = detect only). */
  enforcement?: "block" | "dry-run";
}

export type Phase = "request" | "response" | "egress";

export interface Protection {
  mode: "block" | "dry-run";
  /** Active rules split by phase. */
  rules: { request: unknown[]; response: unknown[]; egress: unknown[] };
  /** (request) => Response (403 when blocked) | null (allow / dry-run). Request phase only. */
  fetchGuard(): (request: Request) => Promise<Response | null>;
  /** Screens the request, then the response (secret-leak redaction / withhold). */
  fetch(handler: (request: Request, ...rest: unknown[]) => unknown): (request: Request, ...rest: unknown[]) => Promise<unknown>;
  /** Screen a fetch Response through the response-phase rules (redact/withhold). */
  screenResponse(response: Response): Promise<Response>;
  express(options?: { screenResponses?: boolean }): (req: unknown, res: unknown, next: () => void) => void;
  node(options?: { maxBodyBytes?: number; screenResponses?: boolean }): (req: unknown, res: unknown, next: () => void) => void;
  /** Present when `egress: true` — restores the original global fetch. */
  uninstallEgress?: () => void;
  /** Present with a live source — re-fetch + hot-swap the rules once (used by the loop + push). */
  refresh?: () => Promise<void>;
  /** Present with a live source — a fetch handler that runs `refresh()` when the request carries
   *  the configured refresh secret (a push/zero-day trigger). No secret set → the handler 404s. */
  refreshHandler?: () => (request: Request) => Promise<Response>;
  /** Present when `refreshMs > 0` — stops the live rule-refresh loop. */
  stopRefresh?: () => void;
}

export interface CreateProtectionOptions {
  /**
   * Fallback when the Pulse rules API does not send `enforcement`.
   * Overridden by `PATCHSTACK_MODE` when set, otherwise by API `enforcement`.
   * Default "dry-run". Scaffolded guards pass "block" when env is unset.
   */
  mode?: "block" | "dry-run";
  /** Explicit rule bundle (used as the token-less fallback). */
  rules?: unknown;
  /** Patchstack WAF token — pull live per-site rules from the API. */
  token?: string;
  baseUrl?: string;
  /** Pulse site UUID — pull live per-site rules from the Pulse rules API (cached). */
  siteUuid?: string;
  /**
   * WP-format site API key (`{secret}-{oauth.id}`) for authenticated block logs
   * via connector `POST /api/logs/log`. Falls back to `PATCHSTACK_API_KEY`, then
   * `.patchstackrc.json` `apiKey`. Never put this in the public widget.
   */
  apiKey?: string;
  /**
   * Credential for the authenticated rules lookup. Falls back to `apiKey`, then
   * `PATCHSTACK_PULSE_AUTH`, then `.patchstackrc.json` `pulseAuth`. Exchanged
   * for a short-lived token; never sent directly. Never put this in the public
   * widget.
   */
  pulseAuth?: string;
  /** Override the Pulse rules API base URL. */
  pulseRulesUrl?: string;
  /**
   * When false, skip posting block events to connector `/api/logs/log`.
   * Also disabled when `PATCHSTACK_TELEMETRY=off` or when no apiKey is available.
   */
  reportFirewallLog?: boolean;
  /**
   * Report EVERY rule that fired — including one in `dry-run` that did not block — to the Pulse
   * detections endpoint. Off unless explicitly `true`.
   *
   * Why it exists: a rule that blocks nothing reports nothing, so a rule that is quietly wrong and a
   * rule that is protecting look identical from the outside.
   *
   * What it sends, per detection: the rule id, the request PATH with the query string removed, the
   * parameters the rule reads, the phase, whether it was enforced, the rule-bundle ETag, and a
   * timestamp. It does NOT send the matched value, the request body, headers, or query-string values —
   * this is a counting channel, not a copy of your traffic.
   *
   * Off by default because switching it on adds an outbound request to every guard with a site UUID.
   */
  reportDetections?: boolean;
  /** How long to buffer detections before posting a batch. Default 5000ms. */
  detectionFlushMs?: number;
  /** Optional Source-Host header for connector hostname checks. */
  sourceHost?: string;
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch;
  /**
   * Re-fetch and hot-swap the live rules every N ms. For long-lived runtimes that aren't restarted
   * on change (an AI builder's sandbox/preview) so a rule that becomes relevant after boot still
   * applies. Default 0 (off) — a real deploy restarts the process, which re-fetches anyway. Only
   * meaningful with a live source (`siteUuid`/`token`).
   */
  refreshMs?: number;
  /**
   * Shared secret gating the push refresh endpoint (`refreshHandler()`): the platform/SaaS hits the
   * endpoint with this secret to trigger an immediate refresh. Falls back to `PATCHSTACK_REFRESH_SECRET`.
   * Unset → the endpoint 404s (never an open refresh trigger).
   */
  refreshSecret?: string;
  /**
   * During a refresh, also re-post the dependency manifest (the runtime counterpart to `scan`) so a
   * dependency added after boot — e.g. via `npm install <pkg>`, which fires no npm lifecycle hook —
   * is reported and enforced without a restart. Defaults on when a `siteUuid` is set; set false to
   * refresh rules only. Only meaningful with `refreshMs > 0` and a Pulse `siteUuid`.
   */
  reportManifest?: boolean;
  /** Directory the manifest re-scan reads the lockfile from during a refresh. Default process.cwd(). */
  cwd?: string;
  /** Directory for the last-known-good rule cache (disk — the default cache backend). */
  cacheDir?: string;
  /**
   * Pluggable last-known-good cache, for runtimes without a filesystem (Workers/Deno). Overrides
   * the disk cache. Stores/returns an opaque envelope; read may return null when nothing is cached.
   */
  ruleCache?: {
    read(): unknown | Promise<unknown>;
    write(envelope: unknown): unknown | Promise<unknown>;
  };
  /** Override the default response-phase (secret-leak) rule set. */
  responseRules?: unknown[];
  /** Override the default egress-phase (SSRF) rule set. */
  egressRules?: unknown[];
  /** Opt in to wrapping global fetch to screen the app's outbound calls (SSRF). */
  egress?: boolean;
  /** Hosts exempt from egress screening. */
  allowHosts?: string[];
  /**
   * Screen the Node http/https path against DNS rebinding: resolve outbound hostnames and block +
   * pin to the vetted address when they map to a disallowed (internal/metadata) IP. Default true;
   * only active when `egress` is on and node:dns is available (a no-op on edge runtimes).
   */
  screenDns?: boolean;
  /** Redaction mask (string or per-category function). Default "[REDACTED]". */
  maskWith?: string | ((category?: string) => string);
  onError?: (err: unknown) => void;
  onEgressBlock?: (info: { url: string; host: string | null; method: string }) => void;
  onDetect?: (detection: {
    phase?: Phase;
    mode: string;
    category?: string;
    rule?: { id?: string | number; category?: string };
    message?: string;
    method?: string | null;
    path?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  }) => void;
}

export function createProtection(options?: CreateProtectionOptions): Promise<Protection>;

export const GUARD_PATH: string;

/** Browser-tunnel guard: evaluate then forward to the app's own Supabase project (SSRF-pinned). */
export function createSupabaseGuard(opts: {
  protection: Protection;
  supabaseUrl?: string;
  fetchImpl?: typeof fetch;
}): (request: Request) => Promise<Response>;

/**
 * Server-function guard: inspect a TanStack server function's decoded args against the same
 * policy. Returns a block receipt to throw on (aborts the call before it writes), or null to allow.
 */
export function createServerFnGuard(opts: {
  protection: Protection;
}): (data: unknown) => Promise<{ rule?: string; message: string } | null>;
