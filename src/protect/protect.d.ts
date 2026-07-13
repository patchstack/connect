// Public types for `@patchstack/connect/protect` (the vendored runtime is plain JS, so the
// declarations are hand-authored and shipped alongside dist/protect.js).

export interface RuleBundle {
  firewall: unknown[];
  whitelists: unknown[];
  whitelist_keys: Record<string, unknown>;
}

export interface Protection {
  mode: "block" | "dry-run";
  rules: RuleBundle;
  /** (request) => Response (403 when blocked) | null (allow / dry-run). */
  fetchGuard(): (request: Request) => Promise<Response | null>;
  fetch(handler: (request: Request, ...rest: unknown[]) => unknown): (request: Request, ...rest: unknown[]) => Promise<unknown>;
  express(): (req: unknown, res: unknown, next: () => void) => void;
  node(options?: { maxBodyBytes?: number }): (req: unknown, res: unknown, next: () => void) => void;
}

export interface CreateProtectionOptions {
  /** Default "dry-run". The scaffolded guard sets "block". */
  mode?: "block" | "dry-run";
  /** Explicit rule bundle (used as the token-less fallback). */
  rules?: unknown;
  /** Patchstack WAF token — pull live per-site rules from the API. */
  token?: string;
  baseUrl?: string;
  /** Directory for the last-known-good rule cache. */
  cacheDir?: string;
  onError?: (err: unknown) => void;
  onDetect?: (detection: { mode: string; rule?: { id?: string }; message?: string }) => void;
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
