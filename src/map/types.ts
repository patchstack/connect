// The build-time input-flow ("attack surface") map. connect's `map` command walks the app's source
// and emits this per-site: entry points → the inputs each reads → the sinks/dependencies they reach.
// It's both a user-facing surface view and the coordinate source dynamic vPatch templates bind against.
//
// Honesty is a first-class field: static analysis is best-effort, so `coverage` records what the
// adapter could and couldn't see. Never present the map as "complete".

/** Where an input is read from — determines which runtime parameter namespace can address it. */
export type InputSource =
  | 'json-body' | 'form-body' | 'multipart' | 'body'
  | 'query' | 'route-param' | 'header' | 'cookie' | 'file'
  | 'server-fn-data' | 'unknown';

export interface InputField {
  /**
   * Parameter / body-field name — the coordinate a rule pins to. Nested validator fields are
   * flattened to dotted paths (`address.city`, `tags[].label`), matching `array_key_value` paths.
   */
  name: string;
  /** Coarse type when derivable (string | number | boolean | array | object | unknown). */
  type?: string;
  /** Declared constraints, when a validator (e.g. zod) exposes them. */
  min?: number;
  max?: number;
  optional?: boolean;
  /** Declared string format when the validator names one (email | uuid | url | …). */
  format?: string;
  /** Declared regex constraint (the regex literal's source text), when present. */
  pattern?: string;
  /** Where the value is read from. */
  source?: InputSource;
  /**
   * The EXACT rule-engine parameter that addresses this input (`post.shipping.email`, `get.q`,
   * `server.HTTP_X_API_KEY`, `cookie.session`, `files.avatar`), or **null** when this input has no exact
   * runtime representation — in which case `runtimeParameterReason` says why. A consumer must never
   * synthesise a coordinate itself: an unaddressable input compiled into a rule produces a rule that
   * silently never matches (e.g. an Express route param is NOT in `get.*`, and an array path needs an
   * `array_key_value` rule rather than a dotted parameter).
   */
  runtimeParameter?: string | null;
  runtimeParameterReason?: string;
}

/** Sink families the extractor recognizes today. Kept as a closed union so a consumer can exhaustively
 * switch on it; add a member here when a recognizer is added. */
export type SinkKind = 'db' | 'fs' | 'http' | 'exec' | 'eval';

export interface Sink {
  kind: SinkKind;
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
  /** The operation at the sink (db: insert | select | …; fs/exec/http: the called function). */
  op?: string;
  /** 1-based line of the sink call, in `file` when present, otherwise in the endpoint's own file. */
  line?: number;
  /**
   * Repo-relative file of the sink call, set ONLY when the sink was reached through an imported module
   * — i.e. it does not live in the endpoint's file. Without this, `line` would point at the wrong file.
   */
  file?: string;
  /**
   * Character span of the sink's operation call in `file` (or the endpoint's file). This is the sink's
   * IDENTITY: flow analysis binds evidence to this exact call, never to a line or an enclosing
   * statement (two sinks can share a line, and a statement can hold unrelated expressions).
   */
  start?: number;
  end?: number;
  /**
   * Stable identity of this sink within the map. `Flow.sink` is an embedded COPY for convenience, so
   * correlate the two on this id rather than by deep-equality — a copy that ever drifts from the
   * inventory entry would otherwise look like a second, distinct sink.
   */
  id?: string;
}

/** Something the analyser could not model at this endpoint — i.e. why it cannot be rule-generated. */
export interface Limitation {
  kind: 'dynamic-key' | 'spread-into-sink' | 'non-static-sink-argument' | 'unresolved-helper';
  /** The offending expression as written, e.g. `body[field]`. */
  detail: string;
  line?: number;
}

export interface Endpoint {
  /** Exported server-fn name / route id / handler — the entry point. */
  name: string;
  /** How it was recognized: server-fn | route-handler | route-registration | server-action. */
  entryKind: string;
  /** HTTP method when known. */
  method?: string;
  /** URL path when known (route registrations / derived from a file-based route's location). */
  route?: string;
  /**
   * true when `route` contains dynamic segments (`/api/items/:id`) — it is a PATTERN, not a literal
   * path, so a rule scoping to it needs a glob/regex `when.path`, not an equality match.
   */
  routeDynamic?: boolean;
  /** Repo-relative source file. */
  file: string;
  /** 1-based line of the entry-point declaration in `file`. */
  line?: number;
  /** UTF-16 offsets of the entry-point declaration in `file`. */
  start?: number;
  end?: number;
  /**
   * Short content fingerprint (sha256 prefix) of `file` at analysis time. A server must treat this
   * endpoint's spans/coordinates as STALE if the file no longer matches — deploys move code.
   */
  fingerprint?: string;
  /** Inventory: inputs the handler reads. Presence here does NOT mean an input reaches a sink. */
  inputs: InputField[];
  /** Inventory: sinks reachable in the handler. Presence here does NOT mean an input flows into it. */
  sinks: Sink[];
  /**
   * Evidence-backed input→sink data links. This — not the `inputs`×`sinks` cross-product — is what a
   * consumer should use to pin a rule to a parameter. Empty when no link could be established.
   */
  flows: Flow[];
  /**
   * false when the endpoint DECLARES an input validator that static analysis could not parse — its
   * `inputs` are UNKNOWN rather than empty. Absent when the extracted inputs can be trusted as-is.
   */
  inputsResolved?: boolean;
  /**
   * Why this endpoint (or a sink within it) cannot be turned into a rule — a dynamic computed key, a
   * spread that hides which field reaches the sink, etc. This is the improvement queue: it is more
   * useful than silently emitting an incomplete picture.
   */
  limitations?: Limitation[];
}

/**
 * A DATA LINK from one input to one sink — the only place the map asserts that an input actually
 * *reaches* a sink. `inputs` and `sinks` on an endpoint are inventories (both present somewhere in the
 * handler); a `Flow` is evidence-backed:
 *   - `precise`   — the input identifier/path appears inside the sink call's arguments.
 *   - `heuristic` — the input and sink co-occur in the handler but no data link was found; treat as
 *                   "may reach", never as proven.
 * Consumers that pin a rule to a parameter should prefer `precise` flows and fall back to broad rules.
 */
/**
 * Which argument of the sink call the tainted value landed in. This decides which mitigation class is
 * even applicable, so a candidate compiler cannot work without it: `command` vs `args` for exec,
 * `url` vs `body` for http, `path` vs `content` for the filesystem, `sql` vs `values` for a database.
 */
export type ArgumentRole =
  | 'command' | 'file' | 'args'
  | 'url' | 'init' | 'body' | 'options'
  | 'path' | 'content'
  | 'sql' | 'values' | 'columns' | 'column' | 'value'
  | 'code' | 'unknown';

/**
 * The mitigation class a flow could support. Deliberately narrow: only patterns where a request value
 * reaching that argument is inherently dangerous and a rule can express it. A request value flowing into
 * generic database *values* is real reachability signal but NOT a blockable pattern on its own, so it
 * gets no family.
 */
export type CandidateFamily = 'ssrf' | 'command-injection' | 'path-traversal' | 'sql-injection' | 'code-injection';

export interface Flow {
  /** Which argument of the sink call received the value (see ArgumentRole). */
  argumentRole?: ArgumentRole;
  /** The mitigation class this flow could support, when the (sink kind, argument role) pair maps to one. */
  candidateFamily?: CandidateFamily;
  /**
   * Whether a Patchstack rule can SAFELY be compiled from this flow — deliberately separate from
   * `confidence`. `precise` means "the source reaches the sink"; it is NOT authorization to block
   * traffic. `ruleGeneratableReasons` lists what is missing, which doubles as the improvement queue.
   */
  ruleGeneratable?: boolean;
  ruleGeneratableReasons?: string[];
  /** Input field name (dotted path), matching an entry in `Endpoint.inputs`. */
  input: string;
  /** The sink reached. */
  sink: Sink;
  confidence: 'precise' | 'heuristic';
  /** 1-based line of the sink call — the auditable evidence location. */
  line?: number;
}

export interface Coverage {
  /** Adapter that produced the map. */
  adapter: string;
  /** Files the walker found under the analyzed roots. */
  filesDiscovered: number;
  /** Files actually parsed (passed the entry-point pre-filter). */
  filesParsed: number;
  /**
   * Files skipped BEFORE parsing because they contained no entry-point signal at all. These are not
   * failures — most of a project is client code. Reported explicitly so a consumer never has to infer
   * it by subtracting, which reads as "91% unanalysed".
   */
  filesPreFiltered: number;
  /** Files skipped because they could not be read/parsed (fail-open). */
  filesSkipped: number;
  /** Source roots analyzed, repo-relative. */
  roots: string[];
  /** Honest notes on what static analysis could not resolve (dynamic dispatch, indirection, …). */
  notes: string[];
}

export interface SiteInputMap {
  /**
   * Schema version of this document. 2 added: input `source` + `runtimeParameter`, sink/endpoint source
   * spans, per-file `fingerprint`, and `ruleGeneratable` on flows. Spans are **UTF-16 code-unit offsets**
   * (JavaScript string indices), not byte offsets; pair them with `fingerprint` so a server can reject
   * stale coordinates after a deploy.
   */
  version: 2;
  /** e.g. "tanstack-start". */
  framework: string;
  endpoints: Endpoint[];
  coverage: Coverage;
}

/** The TypeScript module surface we use (a subset of `typescript`), resolved from the target app. */
export type TsModule = typeof import('typescript');
