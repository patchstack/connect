// Public types for `@patchstack/connect/protect` (the vendored runtime is plain JS, so the
// declarations are hand-authored and shipped alongside dist/protect.js).

export interface RuleBundle {
  firewall: unknown[];
  whitelists: unknown[];
  whitelist_keys: Record<string, unknown>;
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
}

export interface CreateProtectionOptions {
  /** Default "dry-run". The scaffolded guard sets "block". */
  mode?: "block" | "dry-run";
  /** Explicit rule bundle (used as the token-less fallback). */
  rules?: unknown;
  /** Patchstack WAF token — pull live per-site rules from the API. */
  token?: string;
  baseUrl?: string;
  /** Pulse site UUID — pull live per-site rules from the Pulse rules API (cached). */
  siteUuid?: string;
  /** Override the Pulse rules API base URL. */
  pulseRulesUrl?: string;
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
    rule?: { id?: string; category?: string };
    message?: string;
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
