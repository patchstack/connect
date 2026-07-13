import { RequestResolver } from './request.js';
import { normalizeRequest } from './normalizer.js';

const REDOS_PATTERNS = [
  /\(\w\+\)\+/,
  /\(\w\*\)\+/,
  /\(\w\+\)\*/,
  /\(\w\*\)\*/,
  /\(\w\|\w\)\+/
];

function safeRegExp(pattern) {
  if (!pattern) {
    return null;
  }

  for (const dangerous of REDOS_PATTERNS) {
    if (dangerous.test(pattern)) {
      return null;
    }
  }

  const match = pattern.match(/^\/(.+?)\/([gimsuy]*)$/s);
  if (!match) {
    return null;
  }

  try {
    return new RegExp(match[1], match[2]);
  } catch {
    return null;
  }
}

// ctype_*/is_numeric compare their character-class result to the rule's expected
// `value`. Rules are almost always written `{ "type": "ctype_digit", "value": false }`
// meaning "flag when NOT of this class" — so the result must be compared to matchVal,
// not returned raw. Empty/absent values never match (mirrors engine-php's `$value != ''`
// guard), otherwise every missing parameter false-positives a `value:false` rule.
// When `value` is not a boolean (null/omitted) the legacy default of `true` is used, so
// existing rules that relied on the raw class check are unaffected.
function ctypeResult(strValue, isClass, matchVal) {
  if (strValue === '') {
    return false;
  }
  const expected = typeof matchVal === 'boolean' ? matchVal : true;
  return isClass === expected;
}

// array_key_value: navigate `match.key` (a dot-path, or an array of paths) inside the
// decoded value and run the nested `match.match` against whatever it finds. Mirrors
// engine-php's recursive array_key_value handling.
function arrayKeyValue(value, matchObj) {
  if (!matchObj || !matchObj.match || value === null || typeof value !== 'object') {
    return false;
  }
  const keys = Array.isArray(matchObj.key) ? matchObj.key : [matchObj.key];
  const sub = matchObj.match;

  for (const key of keys) {
    let node = value;
    for (const part of String(key).split('.')) {
      if (node === null || typeof node !== 'object') {
        node = undefined;
        break;
      }
      node = node[part];
    }
    if (node === undefined) {
      continue;
    }
    const candidates = Array.isArray(node) ? node : [node];
    for (const candidate of candidates) {
      if (matchValue(sub.type, candidate, sub.value, sub)) {
        return true;
      }
    }
  }
  return false;
}

// Report an unknown/removed match type once, so a rule referencing it is not silently
// unenforced (ADR: "unknown match type → skipped and logged, never silently passed").
const warnedMatchTypes = new Set();
function warnUnsupportedMatchType(type) {
  if (type == null || warnedMatchTypes.has(type)) {
    return;
  }
  warnedMatchTypes.add(type);
  console.warn(
    `[patchstack] Unsupported rule_v2 match type "${type}" — condition treated as no-match. ` +
      `Rules relying on it are not enforced by this engine.`
  );
}

// `matchObj` is the full match object; needed by types that read sibling fields
// (array_key_value reads `key`/`match`). Optional so direct callers/tests can keep
// using the (type, value, matchVal) signature.
function matchValue(type, value, matchVal, matchObj) {
  if (value === null || value === undefined) {
    if (type === 'isset') {
      return false;
    }
    return false;
  }

  const strValue = typeof value === 'string' ? value : String(value);

  switch (type) {
    case 'equals':
      return strValue == matchVal;

    case 'equals_strict':
      return strValue === matchVal;

    case 'contains':
    // engine-php exposes `stripos` as an alias of `contains`.
    case 'stripos': {
      const lower = strValue.toLowerCase();
      const target = String(matchVal).toLowerCase();
      return lower.includes(target);
    }

    case 'not_contains': {
      const lower = strValue.toLowerCase();
      const target = String(matchVal).toLowerCase();
      return !lower.includes(target);
    }

    case 'regex': {
      const regex = safeRegExp(matchVal);
      if (!regex) {
        return false;
      }
      return regex.test(strValue);
    }

    case 'more_than':
      return Number(strValue) > Number(matchVal);

    case 'less_than':
      return Number(strValue) < Number(matchVal);

    case 'ctype_digit':
      return ctypeResult(strValue, /^\d+$/.test(strValue), matchVal);

    case 'ctype_alnum':
      return ctypeResult(strValue, /^[\w$\u0080-\uFFFF]+$/.test(strValue), matchVal);

    case 'is_numeric':
      return ctypeResult(strValue, !isNaN(strValue) && strValue.trim() !== '', matchVal);

    case 'isset':
      return true;

    case 'in_array': {
      const arr = Array.isArray(matchVal) ? matchVal : [matchVal];
      return arr.includes(strValue);
    }

    case 'not_in_array': {
      const arr = Array.isArray(matchVal) ? matchVal : [matchVal];
      return !arr.includes(strValue);
    }

    case 'array_in_array': {
      if (!Array.isArray(value) || !Array.isArray(matchVal)) {
        return false;
      }
      return value.some(v => matchVal.includes(v));
    }

    case 'hostname': {
      try {
        const url = new URL(strValue);
        return url.hostname === matchVal;
      } catch {
        return false;
      }
    }

    case 'quotes':
    // engine-php exposes `inline_js_xss` as an alias of `quotes`.
    case 'inline_js_xss':
      return /['"]/.test(strValue);

    case 'inline_xss':
      // Attribute-breakout heuristic: a quote AND a `>` or `=` (matches engine-php).
      return /['"]/.test(strValue) && /[>=]/.test(strValue);

    case 'ctype_special': {
      // engine-php strips space, `_`, `-`, `,` then applies the alnum/unicode check,
      // and compares the result to `value` (usually false = "flag when NOT clean").
      const stripped = strValue.replace(/[ _\-,]/g, '');
      return ctypeResult(strValue, /^[\w$-￿]*$/.test(stripped), matchVal);
    }

    case 'array_key_value':
      // Navigate `match.key` (dot-path, or array of paths) inside the decoded value and
      // run the nested `match.match` against it — e.g. a json_decode'd body where a
      // specific key must hold a specific value.
      return arrayKeyValue(value, matchObj);

    // file_contains (uploaded-file content scanning) is NOT WordPress-specific, but is
    // not yet implemented in the JS engine (needs multipart body access). Kept as an
    // explicit, documented no-match rather than silently hitting `default`.
    case 'file_contains':
      return false;

    // WordPress-only match types (current_user_cannot, general_xss, getShortcodeAtts,
    // getBlockAtts) have been removed: they depend on WP capabilities, wp_kses_post, and
    // the shortcode/block parsers, and have no meaning in a JS app. They now fall through
    // here and are reported once instead of pretending to be a no-match.
    default:
      warnUnsupportedMatchType(type);
      return false;
  }
}

export class RuleEngine {
  #rules;
  #whitelists;
  #whitelistKeys;
  #onError;
  #reportedErrors = new Set();

  constructor({ firewall = [], whitelists = [], whitelist_keys = {}, onError } = {}) {
    this.#rules = firewall;
    this.#whitelists = whitelists;
    this.#whitelistKeys = whitelist_keys;
    this.#onError = onError;
  }

  // A mitigation engine must never take down the app it protects: any error while
  // evaluating a rule is reported and the request is allowed through (fail open). A
  // malformed rule is skipped without aborting the rest of the ruleset.
  #reportError(err) {
    if (this.#onError) {
      this.#onError(err);
      return;
    }
    // Default: log once per distinct message so a persistently-broken rule doesn't
    // spam per request (never silently swallow — hosts can pass `onError` for structured logging).
    const key = err && err.message ? err.message : String(err);
    if (this.#reportedErrors.has(key)) {
      return;
    }
    this.#reportedErrors.add(key);
    console.error('[patchstack] rule evaluation error (rule skipped, request allowed):', err);
  }

  evaluate(req) {
    let normalizedReq;
    let resolver;
    try {
      normalizedReq = { ...req, ...normalizeRequest(req) };
      resolver = new RequestResolver(normalizedReq);
    } catch (err) {
      this.#reportError(err);
      return { blocked: false, rule: null, message: null }; // fail open
    }

    for (const rule of this.#rules) {
      try {
        const conditions = rule.rule_v2;

        if (!Array.isArray(conditions) || conditions.length === 0) {
          continue;
        }

        if (this.#evaluateRule(conditions, resolver)) {
          if (this.#isWhitelisted(normalizedReq, rule)) {
            continue;
          }

          return {
            blocked: true,
            rule,
            message: rule.message ?? `Blocked by Patchstack WAF rule: ${rule.title ?? rule.id}`
          };
        }
      } catch (err) {
        // Skip this rule and keep evaluating the rest — one bad rule never blocks a
        // request nor shadows the rules after it.
        this.#reportError(err);
      }
    }

    return { blocked: false, rule: null, message: null };
  }

  #evaluateRule(conditions, resolver) {
    const inclusiveConditions = conditions.filter(c => c.inclusive);
    const nonInclusiveConditions = conditions.filter(c => !c.inclusive);

    if (inclusiveConditions.length > 0) {
      let inclusiveHits = 0;

      for (const condition of inclusiveConditions) {
        if (this.#evaluateCondition(condition, resolver)) {
          inclusiveHits++;
        }
      }

      if (inclusiveHits === inclusiveConditions.length) {
        return true;
      }
    }

    for (const condition of nonInclusiveConditions) {
      if (this.#evaluateCondition(condition, resolver)) {
        return true;
      }
    }

    return false;
  }

  #evaluateCondition(condition, resolver) {
    const { parameter, match, mutations } = condition;

    if (parameter === 'rules' && Array.isArray(condition.rules)) {
      return this.#evaluateRule(condition.rules, resolver);
    }

    const values = resolver.resolve(parameter);

    if (values.length === 0) {
      return false;
    }

    for (let value of values) {
      if (mutations) {
        value = resolver.applyMutations(mutations, value);
      }

      // array_key_value inspects the object as a whole (it navigates a key path),
      // so it must not go through the per-value object iteration below.
      if (match.type === 'array_key_value') {
        if (matchValue(match.type, value, match.value, match)) {
          return true;
        }
        continue;
      }

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        for (const v of Object.values(value)) {
          if (matchValue(match.type, v, match.value, match)) {
            return true;
          }
        }
        continue;
      }

      if (matchValue(match.type, value, match.value, match)) {
        return true;
      }
    }

    return false;
  }

  #isWhitelisted(req, rule) {
    if (!this.#whitelists || this.#whitelists.length === 0) {
      return false;
    }

    for (const whitelist of this.#whitelists) {
      if (!Array.isArray(whitelist.rule_v2)) {
        continue;
      }

      if (whitelist.rule_id && whitelist.rule_id !== rule.id) {
        continue;
      }

      const resolver = new RequestResolver(req);
      if (this.#evaluateRule(whitelist.rule_v2, resolver)) {
        return true;
      }
    }

    return false;
  }
}

export const _testExports = { matchValue, safeRegExp };
