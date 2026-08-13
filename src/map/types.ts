// The build-time input-flow ("attack surface") map. connect's `map` command walks the app's source
// and emits this per-site: entry points → the inputs each reads → the sinks/dependencies they reach.
// It's both a user-facing surface view and the coordinate source dynamic vPatch templates bind against.
//
// Honesty is a first-class field: static analysis is best-effort, so `coverage` records what the
// adapter could and couldn't see. Never present the map as "complete".

export interface InputField {
  /** Parameter / body-field name — the coordinate a rule pins to. */
  name: string;
  /** Coarse type when derivable (string | number | boolean | array | object | unknown). */
  type?: string;
  /** Declared constraints, when a validator (e.g. zod) exposes them. */
  min?: number;
  max?: number;
  optional?: boolean;
}

export interface Sink {
  /** db | fs | http | exec | template | redirect | … */
  kind: string;
  /** e.g. "supabase", "pg", "fetch". */
  provider?: string;
  /**
   * The npm package (or `node:` builtin) backing this sink — the link that lets a site's vulnerable
   * dependency (from the manifest / TI) be correlated to the exact input that reaches it. Resolved from
   * the file's imports (e.g. `@supabase/supabase-js`, `express`, `node:child_process`); undefined when
   * it can't be traced (a global like `fetch`, or an untraced indirection).
   */
  package?: string;
  /** For db sinks: the table. */
  table?: string;
  /** For db sinks: insert | update | delete | select | rpc. */
  op?: string;
}

export interface Endpoint {
  /** Exported server-fn name / route id / handler — the entry point. */
  name: string;
  /** How it was recognized: server-fn | route-handler | route-registration | server-action. */
  entryKind: string;
  /** HTTP method when known. */
  method?: string;
  /** URL path when known (route registrations / file-based routes). */
  route?: string;
  /** Repo-relative source file. */
  file: string;
  inputs: InputField[];
  sinks: Sink[];
}

export interface Coverage {
  /** Adapter that produced the map. */
  adapter: string;
  /** Honest notes on what static analysis could not resolve (dynamic dispatch, indirection, …). */
  notes: string[];
}

export interface SiteInputMap {
  version: 1;
  /** e.g. "tanstack-start". */
  framework: string;
  endpoints: Endpoint[];
  coverage: Coverage;
}

/** The TypeScript module surface we use (a subset of `typescript`), resolved from the target app. */
export type TsModule = typeof import('typescript');
