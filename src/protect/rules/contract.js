// The engine's rule vocabulary and shape rules, as data.
//
// A rule document is produced in one place, forwarded through others, and executed here. Each of those
// layers needs the same answer to "is this rule one the engine can run", and a layer that answers it more
// loosely admits a rule that is delivered, counted as protection, and never matches.
//
// The data is richer than a set of name lists so that a consumer can DERIVE validation from it: which
// sources take a key and what keys they take, what a condition group looks like, what operands each match
// type needs, which keys a `when` scope understands, which properties belong to which action. Lists alone
// leave every consumer to reimplement the rest in its own language, and those implementations diverge.
//
// `rule-contract.json` is the published form. `tests/protect/rule-contract.test.ts` reads the engine's own
// source and asserts these descriptions match what it implements.

export const CONTRACT_VERSION = '2.1';

/**
 * Every parameter source, and what it accepts after the dot.
 *
 * - `keyed: false` — used bare (`raw`), never with a key.
 * - `keys: 'any'` — an application field name, which is per-app and cannot be enumerated.
 * - `keys: [...]` — the only keys the resolver answers for.
 * - `key_prefixes: [...]` — a key may instead begin with one of these.
 * - `optional_key_suffixes: [...]` — a key may end with one of these to select part of the value.
 * - `wildcard: true` — a key may end in `*` to fan out over matching fields.
 */
export const SOURCES = Object.freeze({
  raw: Object.freeze({ keyed: false }),
  all: Object.freeze({ keyed: false }),
  false: Object.freeze({ keyed: false }),
  rules: Object.freeze({ keyed: false, group: true }),

  get: Object.freeze({ keyed: true, keys: 'any', wildcard: true }),
  post: Object.freeze({ keyed: true, keys: 'any', wildcard: true }),
  request: Object.freeze({ keyed: true, keys: 'any', wildcard: true }),
  cookie: Object.freeze({ keyed: true, keys: 'any', wildcard: true }),

  // A bare `files.<name>` resolves to the filename; an optional trailing attribute selects another part
  // of the upload. Optional, not required — filename-scoped rules use the bare form.
  files: Object.freeze({
    keyed: true,
    keys: 'any',
    wildcard: true,
    optional_key_suffixes: Object.freeze(['content', 'filename', 'type']),
  }),

  server: Object.freeze({
    keyed: true,
    keys: Object.freeze([
      'REQUEST_URI', 'REQUEST_METHOD', 'HTTP_USER_AGENT', 'HTTP_REFERER', 'HTTP_HOST',
      'REMOTE_ADDR', 'ip', 'CONTENT_TYPE', 'CONTENT_LENGTH',
    ]),
    key_prefixes: Object.freeze(['HTTP_']),
  }),

  response: Object.freeze({
    keyed: true,
    keys: Object.freeze(['status', 'body', 'headers']),
    key_prefixes: Object.freeze(['header.']),
  }),

  egress: Object.freeze({ keyed: true, keys: Object.freeze(['url', 'host', 'method']) }),
});

/**
 * Match types the engine evaluates.
 *
 * `file_contains` is absent: the engine returns false for it unconditionally, so a rule built on it can
 * never match. Publishing it would invite a consumer to author one.
 */
export const MATCH_TYPES = Object.freeze([
  'array_in_array', 'array_key_value', 'contains', 'cors_reflected', 'cross_origin',
  'ctype_alnum', 'ctype_digit', 'ctype_special', 'equals', 'equals_strict',
  'hostname', 'in_array', 'inline_js_xss', 'inline_xss', 'internal_host', 'is_numeric',
  'isset', 'less_than', 'more_than', 'not_contains', 'not_in_array', 'off_origin',
  'quotes', 'regex', 'stripos',
]);

/** Match types evaluated against the whole request or response, which therefore carry no parameter. */
export const PARAMETERLESS_MATCH_TYPES = Object.freeze(['cross_origin', 'off_origin', 'cors_reflected']);

/** Match types that read no operand: presence or a character-class test of the resolved value alone. */
export const OPERANDLESS_MATCH_TYPES = Object.freeze([
  'isset', 'quotes', 'is_numeric', 'ctype_alnum', 'ctype_digit', 'ctype_special',
  'inline_xss', 'inline_js_xss', 'internal_host',
  'cross_origin', 'off_origin', 'cors_reflected',
]);

/**
 * Match types needing operands beyond `value`.
 *
 * `array_key_value` navigates `key` and evaluates `match` against what it finds. Either one missing is a
 * condition that resolves a value and tests nothing.
 */
export const MATCH_OPERANDS = Object.freeze({
  array_key_value: Object.freeze({ required: Object.freeze(['key', 'match']) }),
});

/** Mutations the resolver applies. Anything else is a silent no-op. */
export const MUTATIONS = Object.freeze([
  'base64_decode', 'getArrayValues', 'htmlentitydecode', 'intval', 'json_decode', 'json_encode', 'urldecode',
]);

export const PHASES = Object.freeze(['request', 'response', 'egress']);

export const ACTIONS = Object.freeze([
  'block', 'redact', 'encode', 'set-header', 'remove-header', 'harden-cookie',
]);

/**
 * Keys a `when` scope understands.
 *
 * A scope naming anything else is ignored and the rule applies to every request, so an unrecognised key
 * silently widens a rule that was authored to be narrow.
 */
export const WHEN_KEYS = Object.freeze(['path', 'method']);

/** Properties the engine or runtime reads on a rule. */
export const RULE_PROPERTIES = Object.freeze([
  'id', 'rule_id', 'title', 'category', 'phase', 'action', 'rule_v2', 'when',
  'message', 'enforcement', 'source_revision', 'prefilter',
  'max_bytes', 'bypass_limit',
  'set_headers', 'remove_headers', 'cookie_flags', 'ensure',
]);

/**
 * What each action needs, what it defaults, and which phases can carry it out.
 *
 * `required` is a property without which the action does nothing. `defaulted` is one the runtime supplies
 * — `harden-cookie` applies HttpOnly, Secure and SameSite=Lax on its own, so requiring `cookie_flags`
 * would drop a rule that works.
 *
 * `phases` matters as much: the header mutations are carried out on the response, and a request-phase rule
 * carrying one is not a header mutation at all — it falls through to the blocking path and answers 403.
 */
export const ACTION_PROPERTIES = Object.freeze({
  block: Object.freeze({ required: Object.freeze([]), defaulted: Object.freeze([]), phases: Object.freeze(['request', 'response', 'egress']) }),
  redact: Object.freeze({ required: Object.freeze([]), defaulted: Object.freeze([]), phases: Object.freeze(['response']) }),
  encode: Object.freeze({ required: Object.freeze([]), defaulted: Object.freeze([]), phases: Object.freeze(['response']) }),
  'set-header': Object.freeze({ required: Object.freeze(['set_headers']), defaulted: Object.freeze(['ensure']), phases: Object.freeze(['response']) }),
  'remove-header': Object.freeze({ required: Object.freeze(['remove_headers']), defaulted: Object.freeze([]), phases: Object.freeze(['response']) }),
  'harden-cookie': Object.freeze({ required: Object.freeze([]), defaulted: Object.freeze(['cookie_flags']), phases: Object.freeze(['response']) }),
});

export const LIMITS = Object.freeze({
  maxRules: 5000,
  maxWhitelists: 2000,
  maxConditionsPerRule: 250,
  maxNestingDepth: 12,
  maxRegexLength: 1000,
  maxValueLength: 8192,
});

/** The shape of a condition group: this parameter, and a nested `rules` array. */
export const GROUP_PARAMETER = 'rules';

/** Is this condition a group? Groups carry no match of their own. */
export function isGroup(condition) {
  return condition?.parameter === GROUP_PARAMETER && Array.isArray(condition?.rules);
}

/**
 * @returns {string|null} why this condition is neither a well-formed group nor a well-formed leaf
 *
 * The engine takes the group branch only for `parameter: 'rules'` WITH a `rules` array, and that branch
 * returns before it reads `match`. So `parameter: 'rules'` on its own resolves to a null value and tests
 * nothing, and a group carrying a `match` has that match ignored — both are conditions a reviewer approves
 * believing they do something.
 */
export function conditionShapeProblem(condition) {
  if (!condition || typeof condition !== 'object') return 'condition is not an object';

  const named = condition.parameter === GROUP_PARAMETER;
  const nested = Array.isArray(condition.rules);

  if (named && !nested) {
    return `parameter "${GROUP_PARAMETER}" is a group and needs a "rules" array`;
  }
  if (nested && !named) {
    return `condition carries nested rules but its parameter is ${JSON.stringify(condition.parameter)}; a group must be {"parameter":"${GROUP_PARAMETER}"}`;
  }
  if (named && nested) {
    if (condition.match !== undefined) return 'a group carries no match of its own; the engine ignores it';
    if (condition.mutations !== undefined) return 'a group carries no mutations of its own; the engine ignores them';
    if (condition.rules.length === 0) return 'group has no conditions (would never match)';
  }

  return null;
}

/**
 * Is this a parameter the resolver can resolve?
 *
 * @returns {string|null} why it cannot, or null when it can
 */
export function parameterProblem(parameter) {
  if (parameter === undefined || parameter === null) return null;

  if (Array.isArray(parameter)) {
    if (parameter.length === 0) return 'parameter list is empty';
    for (const member of parameter) {
      const problem = parameterProblem(member);
      if (problem !== null) return problem;
    }

    return null;
  }

  if (typeof parameter !== 'string' || parameter === '') return 'parameter must be a non-empty string';

  const dot = parameter.indexOf('.');
  const name = dot === -1 ? parameter : parameter.slice(0, dot);
  const source = SOURCES[name];

  if (source === undefined) return `unknown parameter source "${name}"`;

  if (dot === -1) {
    return source.keyed === true
      ? `source "${name}" needs a key, e.g. "${name}.fieldname"`
      : null;
  }

  if (source.keyed !== true) return `source "${name}" takes no key`;

  const key = parameter.slice(dot + 1);
  if (key === '') return `source "${name}" needs a key after the dot`;

  return keyProblem(name, source, key);
}

function keyProblem(name, source, key) {
  if (key.endsWith('*') && source.wildcard !== true) {
    return `"${name}" does not fan out over a wildcard key`;
  }

  const bare = key.endsWith('*') ? key.slice(0, -1) : key;

  // An application field name cannot be enumerated, so any non-empty key is accepted.
  if (source.keys === 'any') return null;

  if (Array.isArray(source.keys) && source.keys.includes(bare)) return null;

  for (const prefix of source.key_prefixes ?? []) {
    if (bare.startsWith(prefix) && bare.length > prefix.length) return null;
  }

  const accepted = [
    ...(Array.isArray(source.keys) ? source.keys : []),
    ...(source.key_prefixes ?? []).map((p) => `${p}…`),
  ].join(', ');

  return `"${name}" has no key "${key}" (expected one of: ${accepted})`;
}

/** @returns {string|null} why this match is not one the engine evaluates, or null */
export function matchProblem(match, parameter) {
  if (!match || typeof match !== 'object') return 'condition has no match object';
  if (typeof match.type !== 'string' || match.type === '') return 'match.type must be a non-empty string';
  if (!MATCH_TYPES.includes(match.type)) return `unknown match type "${match.type}"`;

  const parameterless = PARAMETERLESS_MATCH_TYPES.includes(match.type);
  if (!parameterless && (parameter === undefined || parameter === null)) {
    return `match type "${match.type}" needs a parameter`;
  }
  if (parameterless && parameter !== undefined && parameter !== null) {
    return `match type "${match.type}" reads the whole request and takes no parameter`;
  }

  const operands = MATCH_OPERANDS[match.type];
  if (operands) {
    for (const required of operands.required) {
      if (match[required] === undefined || match[required] === null) {
        return `match type "${match.type}" needs "${required}"`;
      }
    }
  } else if (!OPERANDLESS_MATCH_TYPES.includes(match.type) && match.value === undefined) {
    return `match type "${match.type}" needs a value`;
  }

  return null;
}

/** @returns {string|null} why one of these mutations is not implemented, or null */
export function mutationsProblem(mutations) {
  if (mutations === undefined || mutations === null) return null;
  if (!Array.isArray(mutations)) return 'mutations must be an array';

  for (const mutation of mutations) {
    if (typeof mutation !== 'string' || !MUTATIONS.includes(mutation)) {
      return `unknown mutation "${String(mutation)}" — applied as a no-op, so the condition would test the untransformed value`;
    }
  }

  return null;
}

/**
 * @returns {string|null} why this scope would not narrow the rule, or null
 */
export function whenProblem(when) {
  if (when === undefined || when === null) return null;
  if (typeof when !== 'object' || Array.isArray(when)) return 'when must be an object';

  const keys = Object.keys(when);
  if (keys.length === 0) return 'when is empty — remove it, or name a path or method';

  const unknown = keys.filter((key) => !WHEN_KEYS.includes(key));
  if (unknown.length > 0) {
    return `when names no supported key (${unknown.join(', ')}) — the engine understands ${WHEN_KEYS.join(' and ')}, `
      + 'and an unrecognised scope is ignored, so the rule would apply to every request';
  }

  // The values, not only the names. A scope the engine cannot use fails in both directions: an empty string
  // is falsy, so the check is skipped and the rule applies everywhere; an empty list or a non-string matches
  // nothing, so the rule applies nowhere. Neither is what the author wrote.
  if ('path' in when && !isNonEmptyString(when.path)) {
    return 'when.path must be a non-empty string';
  }

  if ('method' in when) {
    const methods = Array.isArray(when.method) ? when.method : [when.method];
    if (methods.length === 0) return 'when.method is an empty list, so the rule would match no method';
    if (!methods.every(isNonEmptyString)) return 'when.method must be a non-empty string, or a list of them';
  }

  return null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** @returns {string|null} why this action cannot be carried out as written, or null */
export function actionProblem(action, rule) {
  if (action === undefined || action === null) return null;
  if (!ACTIONS.includes(action)) return `unknown action "${action}"`;

  const spec = ACTION_PROPERTIES[action];

  for (const required of spec?.required ?? []) {
    if (rule?.[required] === undefined || rule?.[required] === null) {
      return `action "${action}" needs "${required}"`;
    }
  }

  const phase = rule?.phase ?? 'request';
  if (spec !== undefined && !spec.phases.includes(phase)) {
    return `action "${action}" is carried out on the ${spec.phases.join('/')} phase; on "${phase}" the rule blocks instead`;
  }

  return null;
}

/** The whole contract, for publishing and for a consumer to load. */
export function ruleContract() {
  const sources = Object.fromEntries(
    Object.entries(SOURCES).map(([name, spec]) => [name, {
      keyed: spec.keyed === true,
      ...(spec.group === true ? { group: true } : {}),
      ...(spec.keys !== undefined ? { keys: spec.keys === 'any' ? 'any' : [...spec.keys] } : {}),
      ...(spec.key_prefixes ? { key_prefixes: [...spec.key_prefixes] } : {}),
      ...(spec.optional_key_suffixes ? { optional_key_suffixes: [...spec.optional_key_suffixes] } : {}),
      ...(spec.wildcard === true ? { wildcard: true } : {}),
    }]),
  );

  return {
    version: CONTRACT_VERSION,
    sources,
    group_parameter: GROUP_PARAMETER,
    match_types: [...MATCH_TYPES],
    parameterless_match_types: [...PARAMETERLESS_MATCH_TYPES],
    operandless_match_types: [...OPERANDLESS_MATCH_TYPES],
    match_operands: Object.fromEntries(Object.entries(MATCH_OPERANDS).map(([k, v]) => [k, { required: [...v.required] }])),
    mutations: [...MUTATIONS],
    phases: [...PHASES],
    actions: [...ACTIONS],
    action_properties: Object.fromEntries(
      Object.entries(ACTION_PROPERTIES).map(([k, v]) => [k, {
        required: [...v.required],
        defaulted: [...v.defaulted],
        phases: [...v.phases],
      }]),
    ),
    when_keys: [...WHEN_KEYS],
    rule_properties: [...RULE_PROPERTIES],
    limits: { ...LIMITS },
  };
}
