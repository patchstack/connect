// Stack-adapter contract for `patchstack-connect protect`.
//
// Each adapter knows one builder/framework shape: whether it applies (`detect`) and how to
// scaffold + wire the guard into it (`wire`). The orchestrator (index.ts) picks the first
// matching adapter; if none matches it escalates (never silently skips) so the wiring can be
// handed to the builder's own agent instead of a human.

export interface WireOptions {
  /** Seed the broad demo sample rule set instead of the high-precision starter. */
  demo?: boolean;
}

export interface WireResult {
  ok: boolean;
  /** Repo-relative files scaffolded or patched. */
  changed: string[];
}

export interface Adapter {
  /** Stable id, e.g. "tanstack-supabase". */
  name: string;
  /** Human label for messages, e.g. "TanStack Start + Supabase". */
  label: string;
  /** Does this adapter handle the app in `cwd`? */
  detect(cwd: string): boolean;
  /** Scaffold + wire the guard. Only called when `detect()` returned true. */
  wire(cwd: string, opts: WireOptions): WireResult;
}

export type ProtectResult =
  | { status: 'wired'; adapter: string; changed: string[] }
  | { status: 'unsupported'; supported: string[] };
