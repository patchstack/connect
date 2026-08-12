import { RequestResolver } from './request.js';
import { normalizeRequest } from './normalizer.js';

// Catastrophic-backtracking shapes. Broad on purpose: a group whose inner content is quantified
// (+, *, or {n,}) and is itself quantified — (a+)+, (\w+)+, (.*)*, ([a-z]+)*, (ab+)+ — or an
// alternation under an outer quantifier — (a|a)*, (x|y)+. A rule matching one of these is skipped
// (safer than hanging the event loop). Earlier patterns only caught literal-letter groups and
// missed the far more common `\w`/`.`/char-class forms.
const REDOS_PATTERNS = [
  /\([^)]*[+*}][^)]*\)\s*[+*]/,
  /\([^)]*\|[^)]*\)\s*[+*]/
];

export function safeRegExp(pattern) {
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

// Walk a dot-path into a decoded object and invoke `cb({ parent, key, value })` for every leaf it
// reaches, fanning out over arrays at EVERY segment (not just the last) — so `orders.customers.email`
// visits the email of each customer of each order, for arbitrary-length / arbitrarily-nested arrays.
// `cb` gets the container + key so callers can either read (match) or set (redact) the leaf.
export function walkLeaves(node, segments, cb) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const el of node) walkLeaves(el, segments, cb);
    return;
  }
  const [head, ...rest] = segments;
  if (head === undefined || !Object.prototype.hasOwnProperty.call(node, head)) return;
  if (rest.length === 0) {
    const leaf = node[head];
    if (Array.isArray(leaf)) {
      for (let i = 0; i < leaf.length; i++) cb({ parent: leaf, key: i, value: leaf[i] });
    } else {
      cb({ parent: node, key: head, value: leaf });
    }
  } else {
    walkLeaves(node[head], rest, cb);
  }
}

// array_key_value: navigate `match.key` (a dot-path, or an array of paths) inside the decoded value
// and run the nested `match.match` against every leaf it finds (fanning out over arrays at every
// segment). Mirrors engine-php's recursive array_key_value handling.
function arrayKeyValue(value, matchObj) {
  if (!matchObj || !matchObj.match || value === null || typeof value !== 'object') {
    return false;
  }
  const keys = Array.isArray(matchObj.key) ? matchObj.key : [matchObj.key];
  const sub = matchObj.match;

  for (const key of keys) {
    let matched = false;
    walkLeaves(value, String(key).split('.'), ({ value: leaf }) => {
      if (!matched && matchValue(sub.type, leaf, sub.value, sub)) matched = true;
    });
    if (matched) return true;
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

// Internal / private / loopback / link-local / cloud-metadata host check, used by the
// `internal_host` match type for SSRF egress rules. Handles IPv4 (incl. IPv4-mapped IPv6),
// IPv6 loopback/link-local/unique-local, and localhost / *.local / GCP metadata names.
function isInternalHost(hostname) {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === 'metadata.google.internal') return true;
  if (host === '::1' || host === '::') return true;
  if (host.startsWith('fe80:')) return true;
  // IPv6 unique-local (fc00::/7) — only when it is actually IPv6 (contains a colon), so ordinary
  // hostnames that merely start with fc/fd (e.g. fcm.googleapis.com, fd-cdn.example.net) are not
  // misclassified as internal and blocked.
  if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd'))) return true;

  // Dotted IPv4 (incl. dotted IPv4-mapped `::ffff:127.0.0.1`, which ends in dotted form).
  const v4 = host.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4 && isPrivateV4(Number(v4[1]), Number(v4[2]))) return true;

  // Hex IPv4-mapped IPv6 (`::ffff:7f00:1` = 127.0.0.1) — Node's URL doesn't dotted-normalize this
  // form, so classify it here too.
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const g1 = parseInt(mapped[1], 16);
    const g2 = parseInt(mapped[2], 16);
    if (isPrivateV4((g1 >> 8) & 0xff, g1 & 0xff)) return true;
  }
  return false;
}

// Private / loopback / link-local / this-host IPv4 test (first two octets are enough for our ranges).
function isPrivateV4(a, b) {
  if (a === 127 || a === 10 || a === 0) return true; // loopback / private / this-host
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

// Route/method scope for a rule's optional `when: { method, path }`. Fail-open: if the scope can't
// be evaluated, the rule still applies (never silently suppress a rule).
function ruleAppliesTo(when, resolver) {
  try {
    if (when.method) {
      const methods = (Array.isArray(when.method) ? when.method : [when.method]).map((m) => String(m).toUpperCase());
      const actual = String(resolver.resolve('server.REQUEST_METHOD')[0] ?? 'GET').toUpperCase();
      if (!methods.includes(actual)) return false;
    }
    if (when.path) {
      const uri = String(resolver.resolve('server.REQUEST_URI')[0] ?? '/');
      if (!pathMatches(String(when.path), uri.split('?')[0])) return false;
    }
    return true;
  } catch {
    return true;
  }
}

// `when.path`: an exact path, a glob with `*`, or an explicit `/regex/` (starts & ends with `/`).
function pathMatches(pattern, path) {
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    const re = safeRegExp(pattern);
    return re ? re.test(path) : false;
  }
  if (pattern.includes('*')) {
    const re = safeRegExp('/^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^?]*') + '$/');
    return re ? re.test(path) : false;
  }
  return path === pattern;
}

// CSRF primitive: does the request come from a different origin than its own Host? Lenient — a
// missing Origin/Referer (a non-browser client) is NOT treated as cross-origin.
function isCrossOrigin(resolver) {
  try {
    const host = String(resolver.resolve('server.HTTP_HOST')[0] ?? '').toLowerCase();
    if (!host) return false;
    const src = resolver.resolve('server.HTTP_ORIGIN')[0] ?? resolver.resolve('server.HTTP_REFERER')[0];
    if (!src) return false;
    const srcHost = hostFromUrl(String(src));
    return srcHost !== null && srcHost !== host;
  } catch {
    return false;
  }
}

function hostFromUrl(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

// Open-redirect primitive (response phase): a 3xx whose Location header points to a DIFFERENT origin
// than the request's own Host. A relative Location (same-origin) never matches. Needs the request
// Host, which the response phase threads in via reqCtx. Lenient: no Location, no request Host, or a
// same-origin / relative target → not flagged (so it can't false-positive without the signal).
function isOffOriginRedirect(resolver) {
  try {
    const status = Number(resolver.resolve('response.status')[0] ?? 0);
    if (status < 300 || status >= 400) return false;
    const location = resolver.resolve('response.header.location')[0];
    if (!location) return false;
    const target = hostFromUrl(String(location)); // null for a relative (same-origin) Location
    if (target === null) return false;
    const host = String(resolver.resolve('server.HTTP_HOST')[0] ?? '').toLowerCase();
    if (!host) return false;
    return target !== host;
  } catch {
    return false;
  }
}

// `matchObj` is the full match object; needed by types that read sibling fields
// (array_key_value reads `key`/`match`). Optional so direct callers/tests can keep
// using the (type, value, matchVal) signature.
export function matchValue(type, value, matchVal, matchObj) {
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
      // Type-strict by design (`'1' !== 1`). A rule that wants loose matching should use `equals`.
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
      const arr = (Array.isArray(matchVal) ? matchVal : [matchVal]).map((x) => String(x));
      return arr.includes(strValue);
    }

    case 'not_in_array': {
      const arr = (Array.isArray(matchVal) ? matchVal : [matchVal]).map((x) => String(x));
      return !arr.includes(strValue);
    }

    case 'array_in_array': {
      if (!Array.isArray(value) || !Array.isArray(matchVal)) {
        return false;
      }
      const target = matchVal.map((x) => String(x));
      return value.some((v) => target.includes(String(v)));
    }

    case 'hostname': {
      try {
        const url = new URL(strValue);
        return url.hostname === matchVal;
      } catch {
        return false;
      }
    }

    case 'internal_host':
      // SSRF egress: private / loopback / link-local / cloud-metadata destinations.
      return isInternalHost(strValue);

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
        // Route/method scope: a rule may declare `when: { method, path }` to apply only on matching
        // requests (so an auto-generated per-endpoint rule doesn't fire elsewhere).
        if (rule.when && !ruleAppliesTo(rule.when, resolver)) {
          continue;
        }

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

    // `cross_origin` needs the request as a whole (Origin/Referer vs Host), not a single resolved
    // parameter — it's the CSRF primitive: true (→ block) when the request comes from another origin.
    if (match && match.type === 'cross_origin') {
      return isCrossOrigin(resolver);
    }

    // `off_origin` (response phase): true (→ block) when a 3xx redirects to a different origin than
    // the request Host — the open-redirect primitive. Like cross_origin, it needs the whole resolver.
    if (match && match.type === 'off_origin') {
      return isOffOriginRedirect(resolver);
    }

    // `parameter` may be an array (e.g. ["get.action","post.action"]) — the rule_v2 format
    // uses these pervasively to mean "any of these sources". Resolve each and OR the
    // candidate values together. (A bare string resolves as a single source.)
    const params = Array.isArray(parameter) ? parameter : [parameter];
    const values = params.flatMap((p) => resolver.resolve(p));

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

export const _testExports = { matchValue, safeRegExp, isInternalHost };
