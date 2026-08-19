// The closed vocabularies below are derived from `capabilities.ts` — the single versioned definition
// shared with the rule-authoring and rule-binding layers. Declaring a union here too would be a copy,
// and the failure mode of the two disagreeing is silent (a value that can never match).
import {
  ADDRESS_SPACES,
  ARGUMENT_ROLES,
  CANDIDATE_FAMILIES,
  INVOCATION_KINDS,
  INVOCATION_RESOLUTIONS,
  SINK_KINDS,
} from './capabilities.js';

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

/**
 * Where an input lives in the request, as the rule engine addresses it. This — not the field name — is
 * half of an input's identity: `query.id` and `body.id` are different inputs that happen to share a
 * name, and keying by name alone let a rule be pinned to the wrong one.
 */
export type AddressSpace = (typeof ADDRESS_SPACES)[number];

/**
 * A field's declared shape BEFORE it is placed in the request: validator extraction knows a name, a type
 * and constraints, but not which region the value arrives in — so it cannot know the input's identity.
 * `withCoordinates` attaches the space, the coordinate and the id in one step.
 */
export type FieldShape = Omit<InputField, 'id'>;

export interface InputField {
  /**
   * Stable identity: `<address space>:<full path>` (e.g. `get:id`, `post:billing.email`). Two inputs
   * with the same NAME in different spaces are different inputs, and `Flow.inputId` refers to this.
   */
  id: string;
  /**
   * Parameter / body-field name — the coordinate a rule pins to. Nested validator fields are
   * flattened to dotted paths (`address.city`, `tags[].label`), matching `array_key_value` paths.
   * NOT unique within an endpoint: use `id` to correlate.
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
export type SinkKind = (typeof SINK_KINDS)[number];

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
   * How `package` was established — the difference between evidence and a guess. `import`: the
   * receiver resolves to that dependency through this file's imports. `global`: a genuine runtime
   * global (`fetch`, `eval`, `Function`). `inferred`: the receiver could not be resolved, so the
   * package was taken from another import in the file. **Absent**: the receiver could not be
   * attributed at all (e.g. `ctx.db.query(x)`) — the sink is reported for human review but must
   * never drive an auto-generated rule, since any object can own a method by that name.
   */
  attribution?: 'import' | 'global' | 'inferred';
  /**
   * Note on `provider` + `attribution` together: `provider` is a claim about the API at this call site, so
   * it is only set when the RECEIVER was traced (`attribution: 'import'`/`'global'`). An `inferred` package
   * says "this file talks to pg", not "this receiver is a pg client", so no provider is claimed — read
   * `package` as a hint in that case. There is deliberately no separate provider-confidence field: it
   * would be derived from these two and could drift out of step with them.
   */
  /**
   * Set when the receiver resolved to a real package that does **not** establish this kind of API —
   * package provenance is not API provenance. `client.query(x)` on an `@apollo/client` instance traces to
   * a genuine dependency while having nothing to do with SQL. Such a sink is reported for review and can
   * never compile a rule: a candidate here would block legitimate traffic and mitigate nothing.
   */
  apiUnconfirmed?: true;
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
 * see `confidence` for the tier, and `inputId` for WHICH input (a name is not unique). Consumers that pin
 * a rule to a parameter must require a proven tier (`exact-local` / `transformed-local`) and fall back to
 * broad rules otherwise — and only `exact-local` should ever be promoted to blocking automatically.
 */
/**
 * Which argument of the sink call the tainted value landed in. This decides which mitigation class is
 * even applicable, so a candidate compiler cannot work without it: `command` vs `args` for exec,
 * `url` vs `body` for http, `path` vs `content` for the filesystem, `sql` vs `values` for a database.
 */
export type ArgumentRole = (typeof ARGUMENT_ROLES)[number];

/**
 * The mitigation class a flow could support. Deliberately narrow: only patterns where a request value
 * reaching that argument is inherently dangerous and a rule can express it. A request value flowing into
 * generic database *values* is real reachability signal but NOT a blockable pattern on its own, so it
 * gets no family.
 */
export type CandidateFamily = (typeof CANDIDATE_FAMILIES)[number];

export interface Flow {
  /** Which argument of the sink call received the value (see ArgumentRole). */
  argumentRole?: ArgumentRole;
  /** The mitigation class this flow could support, when the (sink kind, argument role) pair maps to one. */
  candidateFamily?: CandidateFamily;
  /**
   * Whether a Patchstack rule can SAFELY be compiled from this flow — deliberately separate from
   * `confidence`. A proven tier means "the source reaches the sink"; it is NOT authorization to block
   * traffic. `ruleGeneratableReasons` lists what is missing, which doubles as the improvement queue.
   */
  ruleGeneratable?: boolean;
  ruleGeneratableReasons?: string[];
  /**
   * Input field name (dotted path) — for display. Not an identity: an endpoint can read the same name
   * from two spaces, so anything that pins a rule must use `inputId`.
   */
  input: string;
  /** Identity of the input this flow starts from — matches `InputField.id`. */
  inputId: string;
  /** The sink reached. */
  sink: Sink;
  /**
   * How the link was established, from strongest to weakest:
   *   - `exact-local`       the input IS an argument of the sink call, seen in this file. The only tier a
   *                         server should consider for AUTOMATIC promotion to blocking.
   *   - `transformed-local` the input reaches the argument through an expression (concatenation, a
   *                         template literal, a wrapper call). The value still arrives in the same
   *                         parameter, so a rule can be compiled — but what reaches the sink is not
   *                         exactly what arrived, so promotion deserves a human or a probe.
   *   - `imported`          the sink lives in another module: the input co-occurs, and the call site is
   *                         not visible here, so no argument-level evidence exists.
   *   - `heuristic`         input and sink are both present in the handler, with no proven link.
   *   - `unknown`           the sink call has no source span at all, so no evidence is even possible. A
   *                         sink reached through a same-file helper is `heuristic`, not this: it was
   *                         located, just not attributable to an argument at this call site.
   */
  confidence: 'exact-local' | 'transformed-local' | 'imported' | 'heuristic' | 'unknown';
  /** 1-based line of the sink call — the auditable evidence location. */
  line?: number;
}

/**
 * How strong a deployment finding is. Not all artifacts prove the same thing:
 *
 *   `config`              the project DECLARES a deployment (`vercel.json`, `wrangler.toml`, `_worker.js`)
 *   `provider-directory`  a provider-specific function directory holding real source
 *   `layout`              an ordinary application folder that MIGHT hold functions (`api/`, `functions/`)
 */
export type DeploymentEvidence = 'config' | 'provider-directory' | 'layout';

export interface DeploymentShape {
  /** Which shape was recognized, e.g. `netlify-functions`. */
  shape: string;
  /** The artifact that proved it, repo-relative, so a consumer can show its evidence. */
  source: string;
  /**
   * How strong the finding is. Not all artifacts prove the same thing:
   *
   *   `config`              the project DECLARES a deployment (`vercel.json`, `wrangler.toml`, `_worker.js`)
   *   `provider-directory`  a provider-specific function directory holding real source
   *   `layout`              an ordinary application folder that MIGHT hold functions (`api/`, `functions/`)
   *
   * `layout` is deliberately weaker: `api/client.ts` is a normal front-end folder and `api/handler.ts` is a
   * platform function, and the directory name is the same either way. A consumer may use `layout` to stay
   * undecided; it must not conclude a server runtime from `layout` alone.
   */
  evidence: DeploymentEvidence;
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
  /**
   * Local modules parsed ONE hop from an entry file (a relative import), for their invocations only — no
   * endpoints and no sinks are taken from them. Counted apart from `filesParsed` because these files were
   * already reported under `filesPreFiltered`, and because the two answer different questions: how much of
   * the app was analysed for entry points, versus how far the invocation inventory reached.
   */
  filesHopParsed?: number;
  /** Files skipped because they could not be read/parsed (fail-open). */
  filesSkipped: number;
  /**
   * Paths the walk never entered: an unreadable directory, a broken link, or a symlinked subtree that
   * leaves the project. Distinct from `filesSkipped` because these never became files — an unwalked
   * subtree makes the project look *smaller*, so no other counter moves.
   */
  pathsUnwalked?: number;
  /**
   * Metrics for the API-invocation pass, so the cost/benefit of parsing more files is decided with numbers
   * rather than intuition.
   *
   * Four buckets, not resolved-vs-not, because a two-way split measures the APP rather than the resolver:
   * a codebase full of local helpers would score badly through no fault of the analysis, and widening the
   * parse would LOWER such a rate by finding more local calls — backwards for a number meant to justify
   * widening the parse.
   *
   *   callsTotal       every call/new expression seen — workload scale
   *   callsDependency  traced to a package: what `apiInvocations` records
   *   callsLocal       a known local binding or an enclosing parameter (`res.json()`) — correctly excluded
   *   callsAmbiguous   a receiver that could not be classified either way, or a computed/dynamic callee
   *
   * **Resolver quality is `callsDependency / (callsDependency + callsAmbiguous)`.** `callsLocal` belongs in
   * neither term: excluding a local helper is a correct answer, not a miss.
   */
  apiInvocations?: number;
  callsTotal?: number;
  callsDependency?: number;
  callsLocal?: number;
  callsAmbiguous?: number;
  sourceBytes?: number;
  analysisMs?: number;
  /**
   * Resident set size when extraction finished — a point-in-time reading, NOT a peak. Named for what it is:
   * the walk's garbage may already have been collected by the time it is taken, so treating it as a
   * high-water mark would overstate it.
   */
  rssBytes?: number;
  /**
   * A real high-water mark, from the OS (`resourceUsage().maxRSS`), but for the whole PROCESS — it includes
   * loading the TypeScript compiler. So it bounds the cost of running `map` from above rather than
   * attributing a peak to extraction alone. Absent where the platform does not report it.
   */
  peakRssBytes?: number;
  /**
   * Invocation shapes this pass cannot see. Present whenever the inventory is — the list IS the statement
   * that the inventory is partial, which is why there is no `apiInventoryComplete` boolean: parsing more
   * files raises recall but none of these go away, so no amount of parsing could make absence here mean
   * "the vulnerable API is not called".
   */
  apiInventoryLimitations?: string[];
  /**
   * Whether `SiteInputMap.imports` covers every discovered file — false when at least one file could not
   * be read or scanned, so a package may be imported without appearing there.
   *
   * This is the field that licenses a NEGATIVE conclusion. A package's absence from the inventory means
   * "not imported" only when this is true; otherwise it means "we do not know", and the difference is a
   * vulnerability wrongly closed. **Absent (rather than false) on maps produced before the inventory
   * existed** — that case is also "we do not know", so a consumer must check the field is present and
   * true, not merely that it isn't false.
   */
  importsComplete?: boolean;
  /**
   * WHY the inventory is incomplete, for a reader deciding what to do about it. Diagnostic only:
   * `importsComplete` remains the single gate a consumer reads, and any non-zero count here makes it
   * false — so this can be ignored entirely without ever licensing a wrong negative.
   *
   * The split that matters is durability. The first three are environmental: a permission, a broken
   * link, a symlink out of the project — a re-run in a different context may resolve them.
   * `unresolvableImports` is inherent: the application does not name the module in a way any static pass
   * can resolve. Collapsed into one number, a reviewer re-runs the scan against a permanent property of
   * the source and reads the identical result as a flake.
   */
  importCoverageGaps?: {
    /** Files present but unreadable. */
    unreadableFiles: number;
    /** Files read but whose imports could not be scanned. */
    unscannableFiles: number;
    /** Paths that produced no file at all — the quietest gap, since no per-file counter moves. */
    unwalkedPaths: number;
    /**
     * Imports whose module cannot be determined statically: a computed specifier (`require(expr)`,
     * `import(expr)`) or an aliased loader (`const r = require`, `(require)(x)`).
     *
     * Counted conservatively — an aliased loader counts even when every call through it passes a
     * literal, because following the alias needs dataflow this scan does not do. That biases toward a
     * false "incomplete", which withholds a negative conclusion rather than granting a wrong one.
     */
    unresolvableImports: number;
  };
  /** Source roots analyzed, repo-relative. */
  roots: string[];
  /** Honest notes on what static analysis could not resolve (dynamic dispatch, indirection, …). */
  notes: string[];
}

export interface SiteInputMap {
  /**
   * Schema version of this document. Treat it as a WIRE CONTRACT: a consumer must reject a version it does
   * not implement rather than parse it optimistically. The v2 → v3 changes are silent-failure shaped —
   * old code keeps running and quietly does the wrong thing:
   *   - flows identify their input by `inputId`, not `input` (a NAME is not unique within an endpoint, so
   *     keying by it can attribute a flow to the wrong parameter);
   *   - `confidence` is a five-tier taxonomy — `precise` no longer exists, so `=== 'precise'` is now
   *     permanently false and every proven flow reads as unproven (use `isProvenFlow`);
   *   - only `exact-local` should feed an automatic promotion to blocking; `transformed-local` is
   *     dry-run / review-only, because what reaches the sink is not exactly what arrived.
   * v2 added: input `source` + `runtimeParameter`, sink/endpoint source spans, per-file `fingerprint`, and
   * `ruleGeneratable` on flows. Spans are **UTF-16 code-unit offsets** (JavaScript string indices), not
   * byte offsets; pair them with `fingerprint` so a server can reject stale coordinates after a deploy.
   */
  version: 3;
  /** e.g. "tanstack-start". */
  framework: string;
  /**
   * Deployment artifacts the project itself declares — a `vercel.json`, a `netlify/functions` directory,
   * a `wrangler.toml` — each with the file or directory that evidenced it.
   *
   * Positive evidence only, and it exists because the negative form is dangerous: a serverless function
   * this extractor cannot parse produces no endpoint, which is indistinguishable from an app that has no
   * server at all. A consumer reading only an empty `endpoints` list would call such an app static and
   * tell its owner there is nothing to protect. An empty list here means "no known deployment artifact
   * was found", never "this app has no server-side runtime" — that claim needs deployment or build
   * attestation, which source analysis cannot supply.
   *
   * Additive, so still version 3: a v3 reader that ignores it keeps behaving correctly.
   */
  deploymentShapes?: DeploymentShape[];
  endpoints: Endpoint[];
  coverage: Coverage;
  /**
   * Every package the app imports — see `ImportedPackage`. **Still version 3 on purpose:** this field is
   * purely additive, so a v3 reader that ignores it keeps behaving correctly. The version exists to catch
   * *silent-failure* changes (a field whose meaning shifted under an unchanged name); a new optional field
   * is not one, and bumping for it would make every existing consumer reject the document instead.
   * Absent on maps produced before this shipped — treat missing as "unknown", never as "imports nothing".
   */
  imports?: ImportedPackage[];
  /**
   * Dependency APIs the app calls — see `ApiInvocation`. **Positive evidence only**: its absence for a
   * package never means the package's API is not called (see `coverage.apiInventoryLimitations`).
   * Collected from the files the extractor parses, which is not every file.
   */
  apiInvocations?: ApiInvocation[];
}

export type InvocationKind = (typeof INVOCATION_KINDS)[number];
export type InvocationResolution = (typeof INVOCATION_RESOLUTIONS)[number];

/**
 * A dependency API the app CALLS, independent of whether request input reaches it.
 *
 * Why this is separate from `Sink`: a sink asserts "a dangerous operation that input can reach", which the
 * extractor can only claim for the few API families it models. An invocation asserts the much simpler
 * "this package's function is called here" — askable for any package, and the entire answer for an advisory
 * whose precondition is calling the vulnerable function rather than feeding it untrusted input. Folding the
 * two together would weaken what a sink means.
 *
 * Every record carries its own evidence (`attribution`, `resolution`, the span) rather than leaving a
 * consumer to infer strength from context: "called on an imported binding" and "called on a value we
 * followed through a factory" are different claims, and a server deciding what to act on needs both told
 * apart and told plainly.
 */
export interface ApiInvocation {
  /** npm package root, scope kept, or a `node:` builtin. */
  package: string;
  /** Module specifiers as written that reached this API. */
  specifiers: string[];
  /** The called function or method, as the package exports/documents it — never a local alias. */
  api: string;
  /**
   * The receiver's name, and ONLY when the binding came straight from the package (`resolution: 'direct'`).
   * Absent for a factory-derived value or a re-exported one, because those names are the app's own — a
   * `pool` re-exported from `./lib`, a `Student` returned by `sequelize.define()` — and reporting them as
   * part of the package's API would invent an API name.
   *
   * For a named import the local name IS the exported name; for a default or namespace import it is the
   * app's alias, so treat this as a hint for a reader and match on `api` when correlating.
   */
  receiver?: string;
  /** `receiver.api` when a receiver is known, else `api` — the form advisories tend to name. */
  symbol: string;
  kind: InvocationKind;
  /** Always `import`: a global has no package, and an inferred package is not evidence about the value. */
  attribution: 'import';
  resolution: InvocationResolution;
  /** How many call sites were seen; `sites` is capped, this is not. */
  callCount: number;
  /** Where it is called — capped, with the span so the exact call can be pointed at. */
  sites: InvocationSite[];
}

/** A call site: the file and line for a human, the span for machine correlation. */
export interface InvocationSite {
  file: string;
  line?: number;
  start?: number;
  end?: number;
}

/** One place a package is imported. */
export interface ImportSite {
  /** Repo-relative file. */
  file: string;
  /** 1-based line of the import statement. */
  line?: number;
}

/**
 * A package the app imports, INDEPENDENT of whether anything flows into it.
 *
 * Why this exists separately from `Endpoint.sinks`: a sink is only recorded for the handful of API
 * families the extractor models (`SinkKind`), so "this app has no sink for package P" is not evidence
 * that P is unused — it usually means P's API is not one we recognize. A consumer correlating a
 * vulnerable dependency against the map needs to tell those two apart, because reading the second as the
 * first turns "we cannot see it" into "it is not reachable" — a confident false negative on a real
 * vulnerability. `recognizedSinkKinds` is what separates them.
 */
export interface ImportedPackage {
  /** npm package root, scope kept (`@supabase/supabase-js`), or a `node:` builtin. */
  package: string;
  /**
   * The module specifiers as WRITTEN, deduped (`lodash`, `lodash/merge`). Advisories are frequently
   * scoped to a subpath ("only `lodash/merge` is affected"), which the package root alone cannot express.
   */
  specifiers: string[];
  /**
   * Imported binding names — `default`, `*` for a namespace import, `require` for a CJS whole-module
   * require, `import()` for a dynamic import, otherwise the named bindings. Only collected from files the
   * extractor fully parsed; see `namesComplete`.
   */
  names?: string[];
  /**
   * false when at least one import of this package came from the cheap specifier scan rather than a full
   * parse, so `names` is a SUBSET of what is actually imported. A consumer must not treat a name's absence
   * as proof it is not imported when this is false.
   */
  namesComplete: boolean;
  /** Where it is imported — capped, so `siteCount` carries the real total. */
  sites: ImportSite[];
  /** Total number of import sites found, including any beyond the `sites` cap. */
  siteCount: number;
  /**
   * Which sink families the extractor can recognize for this package. **Empty means the map cannot answer
   * a dataflow question about this package at all** — not that nothing reaches it. A vulnerability in a
   * package with no recognized kind must stay "needs review"; it can never be closed as unreachable on the
   * strength of this map.
   */
  recognizedSinkKinds: SinkKind[];
}

/** The TypeScript module surface we use (a subset of `typescript`), resolved from the target app. */
export type TsModule = typeof import('typescript');
