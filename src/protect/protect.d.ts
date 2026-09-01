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
  /**
   * Screen a fetch Response through the response-phase rules (redact/withhold/encode).
   *
   * Pass the originating `request` wherever it is available. A response rule can be scoped to a route or a
   * method (`when`), and that scope can only be applied if the engine is given the request the response
   * belongs to — without it, a scoped response rule is delivered, counted as protection, and never matches.
   */
  screenResponse(response: Response, request?: Request): Promise<Response>;
  express(options?: { screenResponses?: boolean }): (req: unknown, res: unknown, next: () => void) => void;
  node(options?: { maxBodyBytes?: number; screenResponses?: boolean }): (req: unknown, res: unknown, next: () => void) => void;
  /** Present when `egress: true` — restores the original global fetch. */
  uninstallEgress?: () => void;
  /** Present with a live source — re-fetch + hot-swap the rules once (used by the loop + push).
   *  Resolves with the outcome of the attempt: `ok: false` means the rules in force came from the
   *  cache or the bundled fallback, not from the source. It does not reject on a source failure. */
  /** Refresh the rules now. `ok` is whether the resolution was clean; `origin` is which source supplied
   *  the rules now in force — `api` and `cache` are Patchstack-delivered, `bundled` is the caller's own
   *  `rules` option, `empty` is none. A fallback is `ok: false` with the origin it fell back to. */
  refresh?: () => Promise<{
    ok: boolean;
    origin?: "api" | "cache" | "bundled" | "empty";
    reason?: string;
  }>;
  /** Present with a live source — a fetch handler that runs `refresh()` when the request carries
   *  the configured refresh secret (a push/zero-day trigger). No secret set → the handler 404s. */
  refreshHandler?: () => (request: Request) => Promise<Response>;
  /** Stops everything with a timer or a buffer behind it: the refresh loop, the block log, the
   *  detection reporter (flushing what it holds). Always present, and safe to call twice. */
  stop: () => void;
  /** Alias of `stop`, under the name callers already have. */
  stopRefresh: () => void;
  /** Whether this guard reports security events, and if not, why not.
   *
   *  Reporting is on for a site enrolled in Patchstack-managed mitigation that is running managed rules
   *  with a credential, and off everywhere else. Each state is distinct so "no events arrived" can be
   *  told apart from "reporting is off" — and it follows refreshes, so a guard that starts on cached or
   *  bundled rules and later receives managed rules begins reporting without a restart.
   *
   *  - `on` — events are being sent
   *  - `disabled-by-config` — `PATCHSTACK_REPORT_DETECTIONS` is false, or `reportDetections: false`
   *  - `disabled-by-telemetry-opt-out` — `PATCHSTACK_TELEMETRY` is false
   *  - `not-enrolled` — no site identity
   *  - `no-managed-rules` — the rules in force did not come from Patchstack
   *  - `unavailable-no-credential` — enrolled, but no credential resolved */
  detectionReporting:
    | "on"
    | "disabled-by-config"
    | "disabled-by-telemetry-opt-out"
    | "not-enrolled"
    | "no-managed-rules"
    | "unavailable-no-credential";
  /** Present when detection reporting is on — delivery counts (in events) and the last acknowledgement.
   *  Carries no request data. */
  detectionHealth?: () => {
    /** Events attempted, acknowledged, refused or unreachable, and dropped for queue pressure. */
    sent: number;
    delivered: number;
    failed: number;
    dropped: number;
    /** Attempts beyond the first. A path that only ever succeeds on a retry is working, and is worth
     *  telling apart from one that never has to retry. */
    retried: number;
    lastDeliveredAt: string | null;
    /** Capability announcements, counted separately: these carry no events, so they never move the
     *  counters above. Zero here alongside delivered events is normal, and so is the reverse. */
    capability: {
      announced: number;
      acknowledged: number;
      failed: number;
      /** Retries of a declaration, counted apart from event retries for the same reason as the rest. */
      retried: number;
      lastAcknowledgedAt: string | null;
    };
  };
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
   * `apiKey` in `.patchstackrc.local.json` (where setup writes it) and then in
   * `.patchstackrc.json` (where installs that predate the split still hold it).
   * Never put this in the public widget.
   */
  apiKey?: string;
  /**
   * Credential for the authenticated rules lookup. Falls back to
   * `PATCHSTACK_PULSE_AUTH`, then `pulseAuth` in `.patchstackrc.local.json` and
   * then in `.patchstackrc.json`, then to `apiKey`. Exchanged for a short-lived
   * token; never sent directly. Never put this in the public widget.
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
   * Opt OUT of reporting every rule that fired — including one in `dry-run` that did not block — to the
   * Pulse detections endpoint.
   *
   * Reporting is ON by default for a site enrolled with Patchstack that is running Patchstack-delivered
   * rules and has a resolvable credential; it is off for a local install and for a guard running its own
   * `rules`. This option can only switch it OFF: passing `true` cannot enable reporting for a site that is
   * not enrolled, because whether a site is managed is Patchstack's answer and not a caller's to assert.
   * `PATCHSTACK_REPORT_DETECTIONS=0` does the same thing from the environment.
   *
   * Why it exists: a rule that blocks nothing reports nothing, so a rule that is quietly wrong and a rule
   * that is protecting look identical from the outside.
   *
   * What it sends, per detection: the rule id, the request PATH with the query string removed, the
   * parameters the rule reads, the phase, whether it was enforced, the rule-bundle ETag, and a timestamp.
   * It does NOT send the matched value, the request body, headers, or query-string values.
   *
   * `detectionReporting` names the state, including the reason when reporting is off.
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
  /**
   * Declare which peers are this deployment's own reverse proxies, so a forwarded header can be believed.
   *
   * With no policy, the client address is whatever the transport observed — the socket peer on Node, and
   * nothing at all in a runtime that exposes no peer, where the provenance reads `unavailable`. A
   * forwarded header is never trusted implicitly: it is ordinary request input that any caller can send.
   *
   * A policy must say WHO is trusted, not just which header to read. Declare at least one of:
   *
   * - `peers` — CIDRs or bare addresses of your front end. An empty list means no peer is trusted, and
   *   one unparseable entry rejects the whole policy.
   * - `hops` — the number of trusted proxies counting from the peer inward, as in the numeric form of
   *   Express's `trust proxy`.
   * - `isTrusted` — a predicate over an address.
   *
   * `header` defaults to `x-forwarded-for`. The chain is read from the application side inward, stopping
   * at the first address that is not trusted, because a proxy appends rather than replaces — so a value
   * the caller prepended is ignored.
   *
   * Any unrecognised key, or any malformed value, rejects the policy rather than being ignored. There are
   * no provider presets: a provider's name does not establish that the provider overwrote the header.
   *
   * Note that `req.ip` is never consulted on the Express path. Under `trust proxy` it is itself
   * header-derived by a policy this guard has not verified, so an application behind a proxy sees the
   * proxy's address until it declares a policy here.
   */
  trustedProxy?: {
    peers?: string[];
    hops?: number;
    header?: string;
    isTrusted?: (ip: string) => boolean;
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
    /** The client address resolved for this request, or null when none could be established. */
    ip?: string | null;
    /** Where `ip` came from: the transport peer, a forwarded header a declared trusted proxy set, or
     *  nothing this guard can stand behind. `ip` is null when this is `unavailable`. */
    clientIpSource?: "runtime" | "trusted-proxy" | "unavailable";
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
