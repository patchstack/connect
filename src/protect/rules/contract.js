// The engine's rule vocabulary, as data, versioned, and shared.
//
// A rule document travels Triage → Hub → SaaS → here, and until this existed every hop checked a
// different, weaker thing. Connect's validator asked only that `match.type` be a non-empty string; SaaS
// required a `parameter` on every condition, which the parameterless primitives do not have. So a rule
// using a source the engine does not resolve — `raw.file`, a bare `get` — passed every gate, shipped, and
// screened NOTHING: the resolver returns no values for it, so the condition never matches and the rule is
// installed, reported, and inert. That is the same failure as a guard that reports itself wired and is not,
// one layer down.
//
// This file is the single description. It is DATA rather than a validator so the other repositories can
// consume the same lists instead of re-deriving them: `capability.json` publishes it, Hub and SaaS check
// against it, and the vPatch skill validates generated rules before they are ever imported.
//
// It is kept honest by `tests/protect/rule-contract.test.ts`, which reads the engine's own source and
// asserts that these lists ARE the implemented sets. A hand-maintained copy of a vocabulary drifts from
// the thing it describes; the test is what makes this a description rather than a second opinion.

/**
 * Bumped when the vocabulary changes in a way a consumer must notice.
 *
 * Additive changes — a new match type, a new mutation — take the minor. Removing or renaming anything, or
 * changing what an existing name means, takes the major: a rule authored against the old meaning is still
 * out there in somebody's bundle.
 */
export const CONTRACT_VERSION = '1.0';

/** Sources used WITHOUT a key. `parameter: 'raw'`, never `raw.something`. */
export const EXACT_SOURCES = Object.freeze(['raw', 'all', 'rules', 'false']);

/**
 * Sources used WITH a key: `get.q`, `server.HTTP_HOST`, `egress.host`.
 *
 * The key is not constrained here on purpose. `get`/`post`/`request`/`cookie` take an application field
 * name, which is per-app and unknowable; `server` takes a CGI-style name; `files` takes a field name. The
 * two that ARE closed sets carry theirs below, because naming a key the engine does not resolve is the
 * same silent failure as naming a source it does not have.
 */
export const KEYED_SOURCES = Object.freeze([
  'get', 'post', 'request', 'cookie', 'server', 'files', 'response', 'egress',
]);

/** Keys the engine resolves for the sources whose key space is closed. */
export const CLOSED_SOURCE_KEYS = Object.freeze({
  response: Object.freeze(['status', 'body', 'headers']),
  egress: Object.freeze(['url', 'host', 'method']),
});

/** Every match type the engine implements. */
export const MATCH_TYPES = Object.freeze([
  'array_in_array', 'array_key_value', 'contains', 'cors_reflected', 'cross_origin',
  'ctype_alnum', 'ctype_digit', 'ctype_special', 'equals', 'equals_strict', 'file_contains',
  'hostname', 'in_array', 'inline_js_xss', 'inline_xss', 'internal_host', 'is_numeric',
  'isset', 'less_than', 'more_than', 'not_contains', 'not_in_array', 'off_origin',
  'quotes', 'regex', 'stripos',
]);

/**
 * Match types that need the request or response AS A WHOLE, not one resolved value.
 *
 * These carry no `parameter`, and a consumer that requires one refuses a valid rule — which is the mirror
 * of the problem above: SaaS did exactly that, so every CSRF and open-redirect template would have been
 * permanently unimportable while looking like a schema violation.
 */
export const PARAMETERLESS_MATCH_TYPES = Object.freeze(['cross_origin', 'off_origin', 'cors_reflected']);

/** Every mutation the engine implements. Anything else is applied as a no-op, silently. */
export const MUTATIONS = Object.freeze([
  'base64_decode', 'getArrayValues', 'htmlentitydecode', 'intval', 'json_decode', 'json_encode', 'urldecode',
]);

export const PHASES = Object.freeze(['request', 'response', 'egress']);

/**
 * Every action the runtime implements.
 *
 * The response-header trio is easy to miss — it is handled in `runtime.js`, not the engine — and a contract
 * that omitted it would refuse three shipped capabilities as unknown. Read from there rather than assumed.
 */
export const ACTIONS = Object.freeze([
  'block', 'redact', 'encode', 'set-header', 'remove-header', 'harden-cookie',
]);

/** Top-level rule properties the engine reads. Anything else is authoring metadata, not behaviour. */
export const RULE_PROPERTIES = Object.freeze([
  'id', 'rule_id', 'title', 'category', 'phase', 'action', 'rule_v2', 'when',
  'max_bytes', 'bypass_limit', 'set_headers', 'ensure', 'prefilter', 'enforcement',
]);

/**
 * The bounds the validator enforces. These are the numbers it already used; they live here so a consumer
 * can reject an over-large rule before it is ever delivered, rather than discovering the cap at runtime.
 */
export const LIMITS = Object.freeze({
  maxRules: 5000,
  maxWhitelists: 2000,
  maxConditionsPerRule: 250,
  maxNestingDepth: 12,
  maxRegexLength: 1000,
  maxValueLength: 8192,
});

/**
 * Is this a parameter the resolver can actually resolve?
 *
 * @returns {string|null} why it cannot, or null when it can
 */
export function parameterProblem(parameter) {
  if (parameter === undefined || parameter === null) return null; // parameterless; the match decides

  // A condition may name SEVERAL parameters, and the engine resolves each of them
  // (`Array.isArray(parameter) ? parameter : [parameter]`). Every member has to be resolvable: one bad
  // entry among good ones is a condition that still fires, via its siblings, while carrying a source that
  // contributes nothing — which is how dead vocabulary survives in a rule that looks like it works.
  if (Array.isArray(parameter)) {
    if (parameter.length === 0) return 'parameter list is empty';
    for (const member of parameter) {
      const problem = parameterProblem(member);
      if (problem !== null) return problem;
    }

    return null;
  }

  if (typeof parameter !== 'string' || parameter === '') return 'parameter must be a non-empty string';
  if (EXACT_SOURCES.includes(parameter)) return null;

  const dot = parameter.indexOf('.');
  if (dot === -1) {
    // The reported case: `get` and `post` alone. They look like sources and resolve to nothing, because
    // the resolver needs a key to look up.
    return KEYED_SOURCES.includes(parameter)
      ? `source "${parameter}" needs a key, e.g. "${parameter}.fieldname"`
      : `unknown parameter source "${parameter}"`;
  }

  const source = parameter.slice(0, dot);
  const key = parameter.slice(dot + 1);
  if (!KEYED_SOURCES.includes(source)) return `unknown parameter source "${source}"`;
  if (key === '') return `source "${source}" needs a key after the dot`;

  const closed = CLOSED_SOURCE_KEYS[source];
  if (closed && !closed.includes(key)) {
    return `"${source}" has no key "${key}" (expected one of: ${closed.join(', ')})`;
  }

  return null;
}

/** @returns {string|null} why this match is not one the engine implements, or null */
export function matchProblem(match, parameter) {
  if (!match || typeof match !== 'object') return 'condition has no match object';
  if (typeof match.type !== 'string' || match.type === '') return 'match.type must be a non-empty string';
  if (!MATCH_TYPES.includes(match.type)) return `unknown match type "${match.type}"`;

  const needsNoParameter = PARAMETERLESS_MATCH_TYPES.includes(match.type);
  if (!needsNoParameter && (parameter === undefined || parameter === null)) {
    return `match type "${match.type}" needs a parameter`;
  }

  return null;
}

/** @returns {string|null} why one of these mutations is not implemented, or null */
export function mutationsProblem(mutations) {
  if (mutations === undefined || mutations === null) return null;
  if (!Array.isArray(mutations)) return 'mutations must be an array';

  for (const mutation of mutations) {
    if (typeof mutation !== 'string' || !MUTATIONS.includes(mutation)) {
      // Named separately from an unknown match type because the consequence differs: an unknown mutation
      // is applied as a no-op, so the condition still runs — against the untransformed value, which is a
      // rule that quietly checks something other than what it says.
      return `unknown mutation "${String(mutation)}" (applied as a no-op, so the condition would run against the untransformed value)`;
    }
  }

  return null;
}

/** The whole contract, for publishing and for a consumer to load. */
export function ruleContract() {
  return {
    version: CONTRACT_VERSION,
    exact_sources: [...EXACT_SOURCES],
    keyed_sources: [...KEYED_SOURCES],
    closed_source_keys: Object.fromEntries(Object.entries(CLOSED_SOURCE_KEYS).map(([k, v]) => [k, [...v]])),
    match_types: [...MATCH_TYPES],
    parameterless_match_types: [...PARAMETERLESS_MATCH_TYPES],
    mutations: [...MUTATIONS],
    phases: [...PHASES],
    actions: [...ACTIONS],
    rule_properties: [...RULE_PROPERTIES],
    limits: { ...LIMITS },
  };
}
