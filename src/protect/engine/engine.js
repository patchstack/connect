import { RequestResolver } from './request.js';
import { notify } from '../notify.js';
import { normalizeRequest } from './normalizer.js';
import { base64DecodeUtf8 } from './request.js';

// Catastrophic-backtracking shapes. Broad on purpose: a group whose inner content is quantified
// (+, *, or {n,}) and is itself quantified — (a+)+, (\w+)+, (.*)*, ([a-z]+)*, (ab+)+ — or an
// alternation under an outer quantifier — (a|a)*, (x|y)+. A rule matching one of these is skipped
// (safer than hanging the event loop). The `NEST` variants allow ONE level of nested parentheses in
// the outer group so a quantified SUBGROUP is caught too (`((ab)+)+`, `((a|b)+)*`) — the earlier
// `[^)]*` forms stopped at the first inner `)` and missed those. `.test()` scans every start offset,
// so deeper nestings match at an inner window too.
const GRP = '(?:[^()]|\\([^()]*\\))*'; // group body allowing one level of nested parens
const REDOS_PATTERNS = [
  /\([^)]*[+*}][^)]*\)\s*[+*]/,
  /\([^)]*\|[^)]*\)\s*[+*]/,
  new RegExp('\\(' + GRP + '[+*}]' + GRP + '\\)\\s*[+*]'), // nested quantified subgroup
  new RegExp('\\(' + GRP + '\\|' + GRP + '\\)\\s*[+*]')    // nested alternation under a quantifier
];

// Adjacent unbounded atoms can still make rejection polynomial even without a nested group (`a+b+c`).
// A literal delimiter resets the run only when the preceding atom cannot consume that delimiter. This
// keeps structured patterns expressible without letting a harmless prefix conceal a risky suffix.
function hasAdjacentUnbounded(body, flags) {
  let previousUnboundedAtom = null;
  for (let i = 0; i < body.length;) {
    const start = i;
    const ch = body[i];
    let assertion = false;
    let literal = null;
    let atom = ch;

    if (ch === '\\') {
      const escaped = body[i + 1] ?? '';
      assertion = /[bBAZz]/.test(escaped);
      if (!/[bBAZzdswDSWnrtvf0-9pPkKxuc]/.test(escaped)) literal = escaped;
      i += Math.min(2, body.length - i);
      atom = body.slice(start, i);
    } else if (ch === '[') {
      i++;
      while (i < body.length) {
        if (body[i] === '\\') i += 2;
        else if (body[i++] === ']') break;
      }
      atom = body.slice(start, i);
    } else if (ch === ')') {
      i++;
      atom = '.'; // Conservatively treat a quantified group as capable of consuming a delimiter.
    } else if (ch === '(') {
      const lookaround = body.startsWith('(?=', i) || body.startsWith('(?!', i)
        || body.startsWith('(?<=', i) || body.startsWith('(?<!', i);
      if (lookaround) {
        i = groupEnd(body, i);
        continue;
      }
      i++;
      if (body.startsWith('?:', i)) i += 2;
      else if (body.startsWith('?<', i)) {
        const nameEnd = body.indexOf('>', i + 2);
        if (nameEnd !== -1) i = nameEnd + 1;
      }
      continue;
    } else if (ch === '|') {
      previousUnboundedAtom = null;
      i++;
      continue;
    } else if ('^$'.includes(ch)) {
      i++;
      continue;
    } else if ('?*+{}'.includes(ch)) {
      previousUnboundedAtom = null;
      i++;
      continue;
    } else {
      if (ch !== '.') literal = ch;
      i++;
    }

    if (assertion) continue;

    let unbounded = false;
    let mayBeEmpty = false;
    if (body[i] === '*' || body[i] === '+') {
      unbounded = true;
      mayBeEmpty = body[i] === '*';
      i++;
    } else if (body[i] === '{') {
      const quantifier = /^\{(\d+)(?:,(\d*))?\}/.exec(body.slice(i));
      if (quantifier) {
        unbounded = quantifier[2] === '';
        mayBeEmpty = Number(quantifier[1]) === 0;
        i += quantifier[0].length;
      }
    } else if (body[i] === '?') {
      mayBeEmpty = true;
      i++;
    }
    if (unbounded && (body[i] === '?' || body[i] === '+')) i++;

    if (unbounded && previousUnboundedAtom !== null) return true;
    if (unbounded) {
      previousUnboundedAtom = atom;
    } else if (previousUnboundedAtom !== null && !mayBeEmpty) {
      try {
        const atomFlags = flags.replace(/[^iu]/g, '');
        const complementaryClass =
          (previousUnboundedAtom === '\\s' && atom === '\\S') ||
          (previousUnboundedAtom === '\\S' && atom === '\\s') ||
          (previousUnboundedAtom === '\\d' && atom === '\\D') ||
          (previousUnboundedAtom === '\\D' && atom === '\\d') ||
          (previousUnboundedAtom === '\\w' && atom === '\\W') ||
          (previousUnboundedAtom === '\\W' && atom === '\\w');
        const excludedLiteral =
          literal !== null && !new RegExp(`^(?:${previousUnboundedAtom})$`, atomFlags).test(literal);
        if (complementaryClass || excludedLiteral) {
          previousUnboundedAtom = null;
        }
      } catch {
        // If exclusion cannot be proved, retain the preceding atom as a conservative backstop.
      }
    }
    if (i === start) i++;
  }
  return false;
}

/**
 * The repetition structure of a pattern body, parsed rather than pattern-matched.
 *
 * Only what the safety check below needs: groups (with their kind and source span), alternation, and
 * quantifiers with their bounds. Everything else — a class, an escape, a literal — is an opaque atom.
 * Returns null for syntax this does not model, and the caller then relies on the textual checks alone.
 */
function parseRepetition(body) {
  let i = 0;

  const parseAlternation = () => {
    const branches = [parseSequence()];
    while (body[i] === '|') {
      i++;
      branches.push(parseSequence());
    }
    return branches.length === 1 ? branches[0] : { type: 'alt', branches };
  };

  const parseSequence = () => {
    const items = [];
    while (i < body.length && body[i] !== '|' && body[i] !== ')') {
      const atom = parseAtom();
      if (atom === null) return null;
      const quantified = parseQuantifier(atom);
      if (quantified === null) return null;
      items.push(quantified);
    }
    return { type: 'seq', items };
  };

  const parseAtom = () => {
    const ch = body[i];
    if (ch === '(') {
      const start = i;
      i++;
      let kind = 'capture';
      if (body.startsWith('?:', i)) {
        kind = 'group';
        i += 2;
      } else if (body.startsWith('?=', i) || body.startsWith('?!', i)) {
        kind = 'look';
        i += 2;
      } else if (body.startsWith('?<=', i) || body.startsWith('?<!', i)) {
        kind = 'look';
        i += 3;
      } else if (body.startsWith('?<', i)) {
        const close = body.indexOf('>', i + 2);
        if (close === -1) return null;
        i = close + 1;
      } else if (body[i] === '?') {
        return null; // a group modifier this does not model
      }
      const inner = parseAlternation();
      if (inner === null || body[i] !== ')') return null;
      i++;
      return { type: 'group', kind, body: inner, source: body.slice(start, i) };
    }
    const start = i;
    if (ch === '[') {
      i++;
      if (body[i] === '^') i++;
      if (body[i] === ']') i++;
      while (i < body.length && body[i] !== ']') i += body[i] === '\\' ? 2 : 1;
      if (body[i] !== ']') return null;
      i++;
      return { type: 'atom', source: body.slice(start, i) };
    }
    if (ch === '\\') {
      const next = body[i + 1];
      if (next === undefined) return null;
      if ((next === 'p' || next === 'P' || next === 'u') && body[i + 2] === '{') {
        const close = body.indexOf('}', i + 3);
        if (close === -1) return null;
        i = close + 1;
      } else if (next === 'k' && body[i + 2] === '<') {
        const close = body.indexOf('>', i + 3);
        if (close === -1) return null;
        i = close + 1;
      } else {
        i += 2;
      }
      return { type: /[bB]/.test(next) ? 'assert' : 'atom', source: body.slice(start, i) };
    }
    if (ch === '^' || ch === '$') {
      i++;
      return { type: 'assert' };
    }
    if (ch === '*' || ch === '+' || ch === '?') return null; // nothing to repeat
    i++;
    return { type: 'atom', source: body.slice(start, i) };
  };

  const parseQuantifier = (atom) => {
    let min;
    let max;
    const ch = body[i];
    if (ch === '*') [min, max, i] = [0, Infinity, i + 1];
    else if (ch === '+') [min, max, i] = [1, Infinity, i + 1];
    else if (ch === '?') [min, max, i] = [0, 1, i + 1];
    else if (ch === '{') {
      const bounds = /^\{(\d+)(,(\d*))?\}/.exec(body.slice(i));
      // Not a quantifier: outside unicode mode, a `{` that does not open one is a literal.
      if (!bounds) return atom;
      min = Number(bounds[1]);
      max = bounds[2] === undefined ? min : bounds[3] === '' ? Infinity : Number(bounds[3]);
      i += bounds[0].length;
    } else {
      return atom;
    }
    if (body[i] === '?') i++; // lazy: the same backtracking, explored in another order
    if (body[i] === '*' || body[i] === '+' || body[i] === '?' || body[i] === '{') return null;
    return { type: 'quant', min, max, body: atom };
  };

  const root = parseAlternation();
  return root !== null && i === body.length ? root : null;
}

/** Every node under `node`, depth first, `node` included. */
function* nodesOf(node) {
  if (!node) return;
  yield node;
  if (node.type === 'alt') for (const branch of node.branches) yield* nodesOf(branch);
  else if (node.type === 'seq') for (const item of node.items) yield* nodesOf(item);
  else if (node.type === 'group' || node.type === 'quant') yield* nodesOf(node.body);
}

// How many ways a bounded nesting may split a run before it counts as catastrophic. `(\d{1,3}\.){3}`
// is 9; `(a{1,30}){1,30}` is 900 and backtracks for as long as anyone waits.
const BOUNDED_NESTING_LIMIT = 100;
// How often an alternation may repeat under a bounded quantifier. `(a|a){1,40}` re-tries both branches
// at every repetition, which is two to the fortieth on a run that does not match.
const BOUNDED_ALTERNATION_LIMIT = 16;
// How often a group holding an optional element may repeat. `(?:a?a?){20}` can place each character in
// either optional slot of any repetition — three to the twentieth ways to fail — and a single `(a?)`
// repeated thirty times is the same shape.
const OPTIONAL_REPEAT_LIMIT = 8;

/**
 * Whether every repetition of `quant` is fenced by characters nothing variable inside it can match.
 *
 * `(?:\.[a-z0-9-]+){0,8}` repeats `[a-z0-9-]+`, but each repetition must start with a `.` that class
 * cannot consume, and `(?:\d[ -]?){13,16}` must start each repetition with a digit its optional
 * separator cannot be. Where one repetition ends and the next begins is then forced, there is one way to
 * split any run, and the nesting costs nothing.
 *
 * The fence is the first or last element of every repetition, mandatory (not itself quantified), and
 * shares no character with any element inside whose extent varies — repeated or merely optional.
 * Without the `u` or `v` flag a class matches UTF-16 code units, so checking every one of them makes that
 * disjointness exact rather than sampled; with either flag only a single literal character is accepted
 * as a fence. Anything this cannot prove is not a fence.
 */
function hasFencedRepetitions(quant, flags) {
  let body = quant.body;
  if (body.type === 'group' && body.kind !== 'look') body = body.body;
  if (body.type !== 'seq' || body.items.length < 2) return false;

  const variable = [...nodesOf(body)].filter((n) => n.type === 'quant' && (n.max > 1 || n.min < n.max));
  if (variable.some((n) => n.body.type !== 'atom' || n.body.source === undefined)) return false;

  const atomFlags = flags.replace(/[^i]/g, '');
  const unicode = /[uv]/.test(flags);
  let insides;
  try {
    insides = variable.map((n) => new RegExp(`^(?:${n.body.source})$`, `${atomFlags}${unicode ? 'u' : ''}`));
  } catch {
    return false;
  }

  const literalOf = (source) => {
    if (source.length === 1 && !'.[]()|^$\\'.includes(source)) return source;
    if (source.length === 2 && source[0] === '\\' && /[^\w\s]/.test(source[1])) return source[1];
    return null;
  };
  const disjoint = (edge) => {
    if (edge?.type !== 'atom' || edge.source === undefined) return false;
    const literal = literalOf(edge.source);
    if (literal !== null) return insides.every((re) => !re.test(literal));
    if (unicode) return false;
    let fence;
    try {
      fence = new RegExp(`^(?:${edge.source})$`, atomFlags);
    } catch {
      return false;
    }
    for (let unit = 0; unit <= 0xffff; unit++) {
      const ch = String.fromCharCode(unit);
      if (fence.test(ch) && insides.some((re) => re.test(ch))) return false;
    }
    return true;
  };

  return disjoint(body.items[0]) || disjoint(body.items[body.items.length - 1]);
}

/**
 * Whether a pattern body has an exponential repetition shape, judged on its structure.
 *
 * A repeated group whose content can itself repeat — with either bound unlimited, or both large — can
 * split one run of input in exponentially many ways, and a non-matching run makes the engine try them
 * all. The outer bound does not have to be `+` or `*`: `(a+){2,40}` and `(.*a){12}` are the same shape.
 * An alternation, or an optional element, repeated without a small bound is refused for the same reason:
 * each repetition can then take the same characters in more than one way. Lookaround bodies are
 * patterns of their own and get the adjacent-atom check as well. Null when the body could not be parsed.
 */
function hasCatastrophicShape(body, flags) {
  const root = parseRepetition(body);
  if (root === null) return null;

  for (const node of nodesOf(root)) {
    if (node.type === 'group' && node.kind === 'look' && hasAdjacentUnbounded(lookaroundBody(node.source), flags)) return true;
    if (node.type !== 'quant' || node.max <= 1) continue;
    const fenced = hasFencedRepetitions(node, flags);
    for (const inner of nodesOf(node.body)) {
      if (inner === node.body && inner.type === 'quant') continue;
      if (inner.type === 'quant' && inner.max > 1 && !fenced) {
        if (node.max === Infinity || inner.max === Infinity || node.max * inner.max > BOUNDED_NESTING_LIMIT) return true;
      }
      if (inner.type === 'quant' && inner.min === 0 && inner.max <= 1 && !fenced
          && (node.max === Infinity || node.max > OPTIONAL_REPEAT_LIMIT)) {
        return true;
      }
      if (inner.type === 'alt' && inner.branches.length > 1 && (node.max === Infinity || node.max > BOUNDED_ALTERNATION_LIMIT)) {
        return true;
      }
    }
  }
  return false;
}

/** A lookaround's own pattern: its source without the `(?=` / `(?!` / `(?<=` / `(?<!` and the `)`. */
function lookaroundBody(source) {
  return source.slice(source.startsWith('(?<') ? 4 : 3, -1);
}

function groupEnd(body, start) {
  let depth = 0;
  let inClass = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (!inClass && ch === '(') depth++;
    else if (!inClass && ch === ')' && --depth === 0) return i + 1;
  }
  return body.length;
}

// Report once when a rule's regex is rejected (ReDoS-shaped or unparseable). Unlike an unknown match
// type, a rejected regex used to fail silently — so a delivered rule protected nothing and nobody knew.
const warnedRejectedPatterns = new Set();
function warnRejectedPatternOnce(pattern) {
  const key = String(pattern);
  if (warnedRejectedPatterns.has(key)) return;
  warnedRejectedPatterns.add(key);
  console.warn(
    `[patchstack] rule_v2 regex pattern rejected (unsafe or invalid) — condition treated as no-match. ` +
      `The rule relying on it is NOT enforced: ${key}`
  );
}

// An absurdly long pattern is either a mistake or an attack on our own matcher; compiling and running
// it on every request is unbounded work. The rule-bundle validator rejects these upstream — this is the
// backstop for a caller-supplied bundle that never went through it.
const MAX_PATTERN_LENGTH = 1000;

// The verdict on a pattern, remembered: a rule's pattern is judged once rather than for every value it
// is matched against. Only the verdict — a fresh RegExp is built per call, because a `g` or `y` pattern
// carries `lastIndex` and a shared instance would leak it between unrelated matches. Bounded, and cleared
// rather than evicted when full, since a rule set holds far fewer patterns than this.
const regexVerdicts = new Map();
const REGEX_VERDICT_LIMIT = 2048;

export function safeRegExp(pattern) {
  if (!pattern) {
    return null;
  }
  if (typeof pattern !== 'string' || pattern.length > MAX_PATTERN_LENGTH) {
    return null;
  }

  const match = pattern.match(/^\/(.+?)\/([gimsuy]*)$/s);
  if (!match) {
    return null;
  }

  let safe = regexVerdicts.get(pattern);
  if (safe === undefined) {
    safe = isSafeBody(match[1], match[2]);
    if (regexVerdicts.size >= REGEX_VERDICT_LIMIT) regexVerdicts.clear();
    regexVerdicts.set(pattern, safe);
  }
  if (!safe) return null;

  try {
    return new RegExp(match[1], match[2]);
  } catch {
    return null;
  }
}

function isSafeBody(body, flags) {
  for (const dangerous of REDOS_PATTERNS) {
    if (dangerous.test(body)) return false;
  }
  if (hasAdjacentUnbounded(body, flags)) return false;
  // In addition to the textual checks above, never instead of them: a shape either one refuses is
  // refused. A body this cannot parse is left to the textual checks and to `new RegExp`.
  if (hasCatastrophicShape(body, flags) === true) return false;
  try {
    new RegExp(body, flags);
  } catch {
    return false;
  }

  return true;
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

// Match types that operate on the whole container (not per-leaf): `isset` (presence) and
// `array_in_array` / `array_key_value` (structural). Everything else is a scalar matcher that must
// fan out over the leaves of an object/array value.
const WHOLE_VALUE_MATCH_TYPES = new Set(['isset', 'array_in_array', 'array_key_value']);

// Iteratively collect every scalar (non-object) leaf of a structured value. Iterative + bounded
// (depth and node caps) so a pathologically deep/large attacker payload STOPS at the bound rather
// than throwing a RangeError that the per-rule catch would swallow into a fail-open bypass.
// `truncated` says the bound was reached: containers past it contributed no leaves.
function collectLeafValues(root, nodeCap = 20000, maxDepth = 1000) {
  const leaves = [];
  const stack = [[root, 0]];
  let visited = 0;
  let truncated = false;
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (node === null || node === undefined) continue;
    if (typeof node !== 'object') {
      leaves.push(node);
      continue;
    }
    if (depth >= maxDepth || visited >= nodeCap) {
      truncated = true;
      continue;
    }
    visited++;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push([node[i], depth + 1]);
    } else {
      for (const k of Object.keys(node)) stack.push([node[k], depth + 1]);
    }
  }
  return { leaves, truncated };
}

// The inspection limits one evaluation reached, as `{ skips: [reason, …] }`, or nothing when it
// reached none. Callers count each reason in their coverage.
function skipsOf(resolver) {
  const skips = resolver?.skips;
  return skips && skips.length > 0 ? { skips } : {};
}

// The whole value as text, for a container too large to walk leaf by leaf. `undefined` when it has
// no text form (a cycle, or nesting deeper than the serialiser allows).
function serialisedValue(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

// Emit a warning at most once per distinct key (keeps a persistent misconfiguration from spamming).
const warnedKeys = new Set();
function warnOnce(key, message) {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
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

// Internal / private / loopback / link-local / cloud-metadata host check behind the `internal_host`
// match type. It CANONICALIZES the host before classifying —
// a textual/prefix check is bypassable by alternate encodings (decimal/hex/octal IPv4, expanded or
// IPv4-mapped IPv6), which is a classic SSRF evasion. Handles localhost / *.local / GCP metadata
// names, every IPv4 spelling inet_aton accepts, and IPv6 loopback/link-local/site-local/unique-local/
// multicast plus the transition forms that carry a v4 destination (mapped, NAT64, 6to4).
/**
 * The host to classify out of a rule parameter's value.
 *
 * `internal_host` was written for the egress phase, where the value IS the destination host. On the
 * request phase the same question arrives as an application parameter, and there the value is almost
 * always a full URL (`?url=http://169.254.169.254/latest/meta-data/`) or a `host:port` pair — neither of
 * which is a hostname, so classifying the raw string answered "not internal" for every one of them. A
 * request-phase SSRF rule was therefore expressible, servable and permanently inert: the exact failure
 * this engine has been repeatedly hardened against, in the one match type meant to prevent it.
 *
 * Only the host is extracted; the classification itself is unchanged, so every canonicalization defence
 * (decimal/hex IPv4, expanded and IPv4-mapped IPv6, trailing dots) still applies to what comes out. A
 * value that is already a bare host passes through untouched, which is what keeps the egress path and
 * the built-in default rule behaving exactly as before.
 */
// Schemes a URL parser treats as hierarchical whatever follows the colon: `http:x`, `http:/x` and
// `http:\\x` all name host `x`.
const SPECIAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file']);

// Strip C0 controls and spaces (U+0000–U+0020) from both ends, in linear time.
function trimControls(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}

function hostFromValue(value) {
  // A URL parser drops tabs and newlines anywhere, and C0 controls and spaces at either end, before it
  // reads anything else — so they are dropped here too, or they would hide the scheme.
  const raw = trimControls(String(value ?? '').replace(/[\t\n\r]/g, '')).trim();
  if (raw === '') return '';

  // A scheme (`http://`, and deliberately any other), a special scheme in any of the shorter spellings a
  // URL parser still resolves to a host, or a protocol-relative URL (either slash direction). Parsing
  // rather than string-slicing is what makes the userinfo evasion (`http://trusted@169.254.169.254/`)
  // resolve to the host actually contacted, and keeps `http://evil.com#@127.0.0.1` resolving to evil.com.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  const relative = /^[\\/]{2}/.test(raw);
  if (relative || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || (scheme !== undefined && SPECIAL_SCHEMES.has(scheme))) {
    try {
      return new URL(relative ? `http:${raw}` : raw).hostname;
    } catch {
      // Unparseable: hand the raw value on, where the host check rejects it rather than guessing.
      return raw;
    }
  }

  // `[::1]:8080` — bracketed IPv6 with or without a port.
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end > 0) return raw.slice(1, end);
  }

  // `169.254.169.254:80`. Only a single colon followed by digits: a bare IPv6 address has several, and
  // must not have its last group mistaken for a port.
  const colon = raw.indexOf(':');
  if (colon > 0 && raw.indexOf(':', colon + 1) === -1 && /^\d+$/.test(raw.slice(colon + 1))) {
    return raw.slice(0, colon);
  }

  return raw;
}

function isInternalHost(hostname) {
  if (!hostname) return false;
  let host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  host = host.replace(/%[^\]]*$/, ''); // strip an IPv6 zone id (fe80::1%eth0)
  host = host.replace(/\.$/, ''); // strip a single trailing dot (127.0.0.1.)

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === 'metadata.google.internal') return true;

  // IPv6 (contains a colon): expand to 8 groups, then classify on the canonical form.
  if (host.includes(':')) {
    const g = expandIPv6(host);
    if (!g) return false;
    const allZeroHi = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
    if (allZeroHi && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // ::, ::1 loopback
    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated, still routed locally)
    if ((g[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
    const low32 = (((g[6] << 16) >>> 0) | g[7]) >>> 0;
    if (allZeroHi && (g[5] === 0xffff || g[5] === 0)) {
      // IPv4-mapped (::ffff:a.b.c.d) / IPv4-compatible (::a.b.c.d) — classify the embedded v4.
      return isPrivateV4Int(low32);
    }
    // NAT64 well-known prefix 64:ff9b::/96 — a translator forwards to the embedded v4, so classify that.
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isPrivateV4Int(low32);
    }
    // NAT64 local-use prefix 64:ff9b:1::/48 — operator-defined translation, never a public destination.
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
    // 6to4 2002::/16 — the relay forwards to the v4 address in the next 32 bits.
    if (g[0] === 0x2002) return isPrivateV4Int((((g[1] << 16) >>> 0) | g[2]) >>> 0);
    return false;
  }

  // IPv4 in any inet_aton spelling (dotted quad, shorthand, decimal, hex, octal).
  const v4 = parseIPv4ToInt(host);
  if (v4 !== null) return isPrivateV4Int(v4);
  return false;
}

// Non-public test on a 32-bit IPv4 integer: private, loopback, link-local, this-host, CGNAT, the IETF
// protocol block, benchmarking, multicast, and reserved space (incl. limited broadcast).
function isPrivateV4Int(n) {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  const c = (n >>> 8) & 0xff;
  if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 127 || a === 10 || a === 0) return true; // loopback / private / this-host
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (Alibaba metadata 100.100.100.200)
  return false;
}

// inet_aton-style parse: 1–4 dot-separated parts, each decimal / 0x-hex / 0-octal; the final part
// fills the remaining low bytes. Returns a uint32, or null if the host isn't a numeric IPv4 form
// (so ordinary hostnames — which contain letters outside [0-9a-fx] or other chars — return null).
function parseIPv4ToInt(host) {
  if (!/^[0-9a-fx]+(\.[0-9a-fx]+)*$/i.test(host)) return null;
  const parts = host.split('.');
  if (parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    let n;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null; // e.g. a bare hex like "7f" (not inet_aton-valid without 0x)
    if (!Number.isInteger(n) || n < 0) return null;
    nums.push(n);
  }
  const last = nums.length - 1;
  let value = 0;
  for (let i = 0; i < last; i++) {
    if (nums[i] > 0xff) return null;
    value += nums[i] * 2 ** (8 * (3 - i));
  }
  const maxLast = 2 ** (8 * (5 - nums.length)) - 1; // the final part fills the remaining low bytes
  if (nums[last] > maxLast) return null;
  value += nums[last];
  if (value < 0 || value > 0xffffffff) return null;
  return value >>> 0;
}

// Expand an IPv6 string (any `::` compression, optional embedded IPv4 tail) to 8 numeric groups,
// or null if it isn't valid IPv6. Lets the classifier compare the canonical form, not a string prefix.
function expandIPv6(host) {
  if (!host.includes(':')) return null;
  let s = host;
  // Embedded IPv4 tail (::ffff:127.0.0.1) → convert the dotted part to two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4ToInt(tail);
    if (v4 === null) return null;
    s = s.slice(0, lastColon + 1) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const back = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (back === null) {
    groups = head;
  } else {
    const fill = 8 - head.length - back.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...back];
  }
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

// Bounded scan for three-part JWT candidates. `eyJ` anchors the header: a JWT header is base64url of a
// JSON object, and every object starting `{"` encodes to `eyJ`, so it is a cheap and precise filter.
// The segment bounds keep a hostile body from turning this into an unbounded decode.
// A candidate is an EXACT three-segment token: the boundaries reject a token that is really a segment
// of something longer in either direction, since `jwt_claim_equals` promises positive identification and
// "the first three segments of this looked like a token" is not that.
//
// They reject a CONTINUATION rather than any adjacent dot — a token followed by a sentence period, or
// sitting in a URL path, is still a token — so only `.` followed by token characters ends the match.
//
// The segment bounds are also the size limit: a payload longer than 8192 characters never becomes a
// candidate, so nothing oversized reaches the decoder. They fix the segment count too, so a candidate
// always splits into exactly three parts.
const JWT_CANDIDATE =
  /(?<![A-Za-z0-9_-])(?<![A-Za-z0-9_-]\.)eyJ[A-Za-z0-9_-]{2,2048}\.[A-Za-z0-9_-]{2,8192}\.[A-Za-z0-9_-]{0,2048}(?![A-Za-z0-9_-])(?!\.[A-Za-z0-9_-])/g;

// base64url → base64. `atob` rejects `-` and `_`, and Node's leniency differs, so the conversion is
// explicit: the node and edge paths must agree about what decodes, or a rule masks on one runtime and
// not the other.
function base64UrlToBase64(segment) {
  const padded = segment.length % 4 === 0 ? segment : segment + '='.repeat(4 - (segment.length % 4));
  return padded.replace(/-/g, '+').replace(/_/g, '/');
}

/**
 * Every distinct JWT in `text` whose payload carries an OWN, TOP-LEVEL `claim` exactly equal to `value`.
 *
 * One implementation, used for both detection and redaction. If the matcher and the redactor decided
 * separately, a token could be reported and not masked — a detection that says "redacted" over a body
 * that still carries the secret — or masked without being reported.
 *
 * Everything that is not a positive identification is a no-match: not three segments, a payload that
 * does not decode or does not parse, a payload that is not a plain object, an oversized payload, a
 * missing claim, a claim that is not a string, or any other value. `hasOwnProperty` is what makes
 * "own" true — without it `constructor` or `toString` would read off the prototype and match nothing
 * the token actually said.
 *
 * No signature verification: the question is what the token CLAIMS to be, not whether it is authentic.
 * A forged claim gains an attacker nothing here — this decides whether OUR secret is leaving.
 */
export function jwtClaimSpans(text, claim, value) {
  const found = new Set();
  if (typeof text !== 'string' || typeof claim !== 'string' || claim === '') return [];
  const wanted = String(value);

  for (const [token] of text.matchAll(JWT_CANDIDATE)) {
    const parts = token.split('.');

    let payload;
    try {
      payload = JSON.parse(base64DecodeUtf8(base64UrlToBase64(parts[1])));
    } catch {
      continue; // undecodable or not JSON — not identified, so not matched
    }
    // `null` matters more than it looks: `hasOwnProperty.call(null, …)` THROWS, and an exception here
    // would leave the engine's per-rule catch to fail the rule open — a leak served because a
    // neighbouring token had the payload `null`. Arrays and primitives simply cannot carry a claim.
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
    // "Own" is load-bearing only when something has polluted Object.prototype with a string-valued
    // property — then a payload carrying no `role` at all would otherwise read one off the prototype
    // and be judged on a value the token never contained.
    if (!Object.prototype.hasOwnProperty.call(payload, claim)) continue;

    const actual = payload[claim];
    if (typeof actual === 'string' && actual === wanted) found.add(token);
  }

  return [...found];
}

// Report a `when` block that names nothing this engine understands. Fail-open is correct for a scope that
// cannot be EVALUATED, but a scope that cannot be UNDERSTOOD is an authoring mistake with the opposite
// consequence: the rule silently applies to every request instead of one route, which for a blocking rule
// is a false-positive surface across the whole app. Warned once so it is discoverable in a log.
const warnedScopes = new Set();
function warnUnrecognisedScope(when) {
  const key = Object.keys(when).sort().join(',');
  if (warnedScopes.has(key)) return;
  warnedScopes.add(key);
  console.warn(
    `[patchstack] Rule scope \`when: { ${key} }\` names no supported key — the engine understands ` +
      `\`method\` and \`path\`. The scope is IGNORED and the rule applies to every request.`
  );
}

// Route/method scope for a rule's optional `when: { method, path }`. Fail-open: if the scope can't
// be evaluated, the rule still applies (never silently suppress a rule).
function ruleAppliesTo(when, resolver) {
  try {
    if (when.method === undefined && when.path === undefined && Object.keys(when).length > 0) {
      warnUnrecognisedScope(when);
    }
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

// A `when.path` scope names an ENDPOINT, and no HTTP router decides which endpoint a request reached by
// comparing the target byte for byte. Measured over raw sockets (so nothing upstream normalized the
// target first) against Express 4.22, Express 5.2 and Fastify 5, each with one handler on `/api/fetch`:
//
//     /api/fetch/      runs the handler on Express      404 on Fastify
//     /API/fetch       runs the handler on Express      404 on Fastify
//     /api/%66etch     404 on Express                   runs the handler on Fastify
//
// All three run the handler, so all three are the endpoint the scope names and a scope has to cover
// them; a byte comparison covers only the first. The percent-encoded one is already covered, because
// `normalizeRequest` url-decodes the target before any rule is evaluated — decoding a second time here
// would resolve a DOUBLE encoding as well and widen every scope onto requests no router resolves. What
// is left to fold is case and one trailing slash.
//
// Deliberately NOT folded: duplicate slashes, dot segments and an encoded separator (`/api//fetch`,
// `/api/./fetch`, `/api%2Ffetch`) reach no handler on either router, so folding them would widen every
// scope in the field on a guess instead of on evidence. (A proxy that merges slashes does it before the
// app is reached, so the engine already sees the merged path.)
//
// The direction of the remaining error is what makes the fold safe. If an app IS case- and slash-strict,
// the extra requests a folded scope covers 404 anyway, so a rule firing there refuses something already
// destined to fail. If the app is not strict, a rule that stays quiet lets the exploit through.
function foldPathForScope(value) {
  const out = String(value).toLowerCase();
  // One trailing slash, not a run of them: one is what a router forgives, and `//` is in the not-folded
  // list above.
  return out.endsWith('/') ? out.slice(0, -1) : out;
}

// `when.path`: an exact path, a glob with `*`, or an explicit `/regex/`.
//
// The regex form is delimited by slashes — and EVERY path starts with one, so a path that also ends with
// one used to be read as a regex. `path: '/admin/'`, the most ordinary way to write a directory, compiled
// to the unanchored `/admin/` and scoped the rule to every path CONTAINING "admin": `/xadminy`,
// `/admin/users`, all of it. A scope that reads narrow and behaves app-wide is the failure this whole
// mechanism exists to avoid, so the regex form now has to actually use regex syntax. A delimiter pair
// around a plain literal is a path, which is what the author typed, and the narrower of the two readings.
const REGEX_SYNTAX = /[\\^$*+?()[\]{}|]/;

// The same delimiter-and-flags shape `safeRegExp` compiles, so detecting the form and compiling it
// cannot disagree about what a pattern is. Detection missed the flagged form entirely before: a scope
// written `/^\\/admin$/i` does not end in a slash, so it was read as a literal path and matched nothing —
// a rule scoped to a route that cannot exist protects nothing while reporting as scoped.
const REGEX_FORM = /^\/(.+?)\/([gimsuy]*)$/s;

function isRegexForm(pattern) {
  const parts = REGEX_FORM.exec(pattern);
  // Flags alone do not settle it. `/admin/i` reads as a regex but asks for nothing a plain path does not,
  // now that an exact scope folds case — while `/blog/s` is a perfectly ordinary route. So the body has
  // to actually use regex syntax before the pattern is compiled as one, which is the narrower of the two
  // readings and the right way for an ambiguous scope to fail.
  return parts !== null && REGEX_SYNTAX.test(parts[1]);
}

function pathMatches(pattern, path) {
  // An author's own pattern runs against the target as it arrived, unfolded: they wrote the character
  // class and the flags, and silently lowercasing the subject would break a pattern that matches on case.
  if (isRegexForm(pattern)) {
    const re = safeRegExp(pattern);
    return re ? re.test(path) : false;
  }
  const target = foldPathForScope(path);
  const folded = foldPathForScope(pattern);
  if (folded.includes('*')) {
    // A trailing `/*` has to cover the bare directory as well. Measured: `/admin/` runs an Express
    // handler registered at `/admin/*` — and the fold above has already turned that request into
    // `/admin`, so without this the scope would miss the request it is named after. `/admin` itself is
    // then covered too, though it 404s on such a route: the same direction of error as the fold, and the
    // alternative is a scope that stands aside while the handler runs.
    const trailing = folded.endsWith('/*');
    const body = (trailing ? folded.slice(0, -2) : folded).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^?]*');
    const re = safeRegExp('/^' + body + (trailing ? '(?:/[^?]*)?' : '') + '$/');
    return re ? re.test(target) : false;
  }
  return target === folded;
}

// Drop a default port so `app.com:443` and `app.com` compare equal (a real proxy shape), without
// dropping a non-default port (so genuine cross-port stays distinguishable).
function normalizeDefaultPort(host) {
  return String(host).toLowerCase().replace(/:(?:80|443)$/, '');
}

// CSRF primitive: does the request come from a different origin than its own Host? Lenient only when
// the Origin AND Referer are TRULY ABSENT (a non-browser client). A present-but-opaque `Origin: null`
// / empty / unparseable value is NOT same-origin — it's the sandboxed-iframe / opaque-origin signal a
// CSRF attacker supplies, so it is treated as cross-origin.
function isCrossOrigin(resolver) {
  try {
    const host = normalizeDefaultPort(String(resolver.resolve('server.HTTP_HOST')[0] ?? ''));
    if (!host) return false;
    const originRaw = resolver.resolve('server.HTTP_ORIGIN')[0];
    const hasOrigin = originRaw !== undefined && originRaw !== null;
    const src = hasOrigin ? originRaw : resolver.resolve('server.HTTP_REFERER')[0];
    if (src === undefined || src === null) return false; // both absent → lenient
    const s = String(src).trim();
    if (hasOrigin && (s === '' || s.toLowerCase() === 'null')) return true; // present but opaque → cross-origin
    const srcHost = hostFromUrl(s);
    if (srcHost === null) return hasOrigin; // present-but-unparseable Origin → treat as cross-origin
    return normalizeDefaultPort(srcHost) !== host;
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
    const host = String(resolver.resolve('server.HTTP_HOST')[0] ?? '').toLowerCase();
    if (!host) return false;
    // Resolve the Location the way a browser would before comparing hosts: strip TAB/CR/LF and
    // normalize backslashes to forward slashes (browsers do), then resolve against the request origin
    // as a base. A relative `/path` resolves to our own host (not flagged); a protocol-relative
    // `//evil.com` or backslash `/\evil.com` resolves off-origin (flagged) — the canonical
    // open-redirect payloads that a base-less `new URL()` used to treat as "relative & safe".
    const loc = String(location).replace(/[\t\r\n]/g, '').replace(/\\/g, '/');
    let target;
    try {
      target = new URL(loc, 'http://' + host).host.toLowerCase();
    } catch {
      return false; // unresolvable even with a base → not a redirect we can judge
    }
    return normalizeDefaultPort(target) !== normalizeDefaultPort(host);
  } catch {
    return false;
  }
}

// CORS-reflection primitive (response phase): the response allows credentials AND lets any origin
// read it — either `Access-Control-Allow-Origin: *`, or it reflects the caller's own Origin (so
// every origin is allowed) — rather than a fixed allowlisted origin. That combination lets any
// malicious site read the authenticated response. Needs the request Origin (threaded via reqCtx).
// Lenient: credentials not allowed, no ACAO, or a fixed (non-reflected, non-*) ACAO → not flagged.
function isReflectedCorsWithCredentials(resolver) {
  try {
    const acac = String(resolver.resolve('response.header.access-control-allow-credentials')[0] ?? '').toLowerCase();
    if (acac !== 'true') return false; // only dangerous when credentials are allowed
    const acao = String(resolver.resolve('response.header.access-control-allow-origin')[0] ?? '');
    if (!acao) return false;
    if (acao === '*') return true; // wildcard + credentials
    if (acao.toLowerCase() === 'null') return true; // `null` + credentials is readable from a sandboxed iframe (Origin: null)
    const origin = String(resolver.resolve('server.HTTP_ORIGIN')[0] ?? '');
    if (!origin) return false;
    return acao === origin; // ACAO echoes the caller's Origin → any origin is allowed
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

  // Guard the coercion: String() on a pathologically deep array/object can throw RangeError
  // (stack overflow). Catching it here keeps a hostile nested value from failing the rule open.
  let strValue;
  if (typeof value === 'string') {
    strValue = value;
  } else {
    try {
      strValue = String(value);
    } catch {
      strValue = '';
    }
  }

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
        warnRejectedPatternOnce(matchVal);
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
      // SSRF: private / loopback / link-local / cloud-metadata destinations. The value may be a bare
      // host (egress) or a URL / host:port in an application parameter (request) — see `hostFromValue`.
      return isInternalHost(hostFromValue(strValue));

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

    case 'jwt_claim_equals':
      // Detection and redaction share `jwtClaimSpans`, so a token is reported exactly when it is
      // masked. `redact` derives its spans from the same call — see `extractRedactors`.
      return jwtClaimSpans(strValue, matchObj?.claim, matchVal).length > 0;

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
    // A whitelist with no `rule_id` suppresses EVERY rule when its (attacker-reachable) condition
    // trips — almost never intended. And `whitelist_keys` is accepted but not implemented. Warn once
    // for each so a misconfiguration that silently weakens the firewall is visible to the operator.
    if (Array.isArray(whitelists) && whitelists.some((w) => w && Array.isArray(w.rule_v2) && !w.rule_id)) {
      warnOnce(
        'whitelist-no-rule-id',
        '[patchstack] a whitelist has no `rule_id` — it suppresses ALL rules when it matches. ' +
          'Scope each whitelist to a specific rule_id, and key it only on values an attacker cannot set.'
      );
    }
    if (whitelist_keys && typeof whitelist_keys === 'object' && Object.keys(whitelist_keys).length > 0) {
      warnOnce('whitelist-keys-unimplemented', '[patchstack] `whitelist_keys` is not implemented and has no effect.');
    }
  }

  // A mitigation engine must never take down the app it protects: any error while
  // evaluating a rule is reported and the request is allowed through (fail open). A
  // malformed rule is skipped without aborting the rest of the ruleset.
  #reportError(err) {
    // A host handler that runs takes over reporting. One that THROWS does not: fall through to the
    // built-in logging below, or a rule error would disappear into a broken reporter.
    if (notify(this.#onError, err, 'onError')) {
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
      // Past the normalizer's depth bound a value is matched un-normalized; that is reported.
      let limited = false;
      normalizedReq = { ...req, ...normalizeRequest(req, { onLimit: () => { limited = true; } }) };
      resolver = new RequestResolver(normalizedReq);
      if (limited) resolver.noteSkip('container-cap');
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
            message: rule.message ?? `Blocked by Patchstack WAF rule: ${rule.title ?? rule.id}`,
            // The resolver this match was decided by, for whatever needs to report on it. A consumer
            // that re-read the request instead would be reading it a second time: a getter, a stream or
            // anything else that answers once can give a different value, and evidence that disagrees
            // with the match it belongs to is worse than none.
            resolver,
            ...skipsOf(resolver)
          };
        }
      } catch (err) {
        // Skip this rule and keep evaluating the rest — one bad rule never blocks a
        // request nor shadows the rules after it.
        this.#reportError(err);
      }
    }

    return { blocked: false, rule: null, message: null, ...skipsOf(resolver) };
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

    // `cors_reflected` (response phase): true (→ block) when the response allows credentials and
    // reflects the caller's Origin (or uses `*`) — the CORS-misconfiguration primitive. Needs the
    // whole resolver (request Origin vs response ACAO/ACAC).
    if (match && match.type === 'cors_reflected') {
      return isReflectedCorsWithCredentials(resolver);
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

      // A structured (object / array-of-object) value must be inspected at every leaf: a payload
      // nested deeper than a scalar rule expects would otherwise stringify to "[object Object]" and
      // evade the match, while the app still reads the live value. Whole-value match types
      // (isset / array_in_array) see the container; scalar matchers fan out over all leaves.
      if (typeof value === 'object' && value !== null) {
        if (WHOLE_VALUE_MATCH_TYPES.has(match.type)) {
          if (matchValue(match.type, value, match.value, match)) return true;
        } else {
          const { leaves, truncated } = collectLeafValues(value);
          for (const leaf of leaves) {
            if (matchValue(match.type, leaf, match.value, match)) return true;
          }
          // Past the walk's bound, the rest of the value is matched as its serialised text, and the
          // bound is reported: the leaves beyond it were not inspected individually.
          if (truncated) {
            resolver.noteSkip('container-cap');
            const text = serialisedValue(value);
            if (text !== undefined && matchValue(match.type, text, match.value, match)) return true;
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
