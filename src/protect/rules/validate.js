// Rule-bundle validation. Delivered rules are POLICY fetched over the network, and the engine executes
// them on every request — so an upstream compromise, a schema drift, or a mistake in the corpus could
// otherwise hand the app unbounded work (a 50k-rule bundle, a 500-deep condition tree, a pathological
// regex) or silently unenforceable junk.
//
// Two principles:
//   1. REJECT, don't silently skip. A rule that fails validation is dropped WITH a reported reason, so
//      an unenforceable rule is visible instead of quietly protecting nothing.
//   2. Bound everything the engine will walk: rule count, conditions per rule, nesting depth, and
//      pattern length. Caps are deliberately far above any real corpus rule.
//
// Fail-open in spirit: validation never throws, and a bundle whose rules are all rejected simply means
// "no rules" (the app keeps serving) — never a crash.

export const LIMITS = {
  maxRules: 5000,
  maxWhitelists: 2000,
  maxConditionsPerRule: 250,
  maxNestingDepth: 12,
  maxRegexLength: 1000,
  maxValueLength: 8192,
};

const PHASES = new Set(['request', 'response', 'egress']);
const ACTIONS = new Set(['block', 'redact', 'encode', 'set-header', 'remove-header', 'harden-cookie']);

/**
 * Validate a delivered bundle. Returns `{ bundle, rejected }` where `bundle` contains only rules that
 * passed and `rejected` is `[{ id, reason }]` for everything dropped.
 * @param {object} bundle
 * @returns {{ bundle: object, rejected: Array<{id: string, reason: string}> }}
 */
export function validateBundle(bundle) {
  const rejected = [];
  const inFirewall = Array.isArray(bundle?.firewall) ? bundle.firewall : [];
  const inWhitelists = Array.isArray(bundle?.whitelists) ? bundle.whitelists : [];

  const firewall = [];
  for (const rule of inFirewall) {
    if (firewall.length >= LIMITS.maxRules) {
      rejected.push({ id: idOf(rule), reason: `bundle exceeds maxRules (${LIMITS.maxRules})` });
      continue;
    }
    const reason = ruleProblem(rule);
    if (reason) rejected.push({ id: idOf(rule), reason });
    else firewall.push(rule);
  }

  const whitelists = [];
  for (const wl of inWhitelists) {
    if (whitelists.length >= LIMITS.maxWhitelists) {
      rejected.push({ id: idOf(wl), reason: `bundle exceeds maxWhitelists (${LIMITS.maxWhitelists})` });
      continue;
    }
    // A whitelist SUPPRESSES rules, so a malformed one is a protection risk, not a detection risk.
    const reason = conditionsProblem(wl?.rule_v2);
    if (reason) rejected.push({ id: idOf(wl), reason: `whitelist: ${reason}` });
    else whitelists.push(wl);
  }

  return {
    bundle: { ...bundle, firewall, whitelists },
    rejected,
  };
}

function idOf(rule) {
  const id = rule?.id ?? rule?.rule_id;
  return id === undefined || id === null ? '(unidentified)' : String(id);
}

/** @returns {string|null} a reason the rule must be dropped, or null when it's acceptable. */
function ruleProblem(rule) {
  if (!rule || typeof rule !== 'object') return 'not an object';
  if (rule.phase !== undefined && !PHASES.has(rule.phase)) return `unknown phase "${rule.phase}"`;
  if (rule.action !== undefined && !ACTIONS.has(rule.action)) return `unknown action "${rule.action}"`;
  const capOverride = rule.max_bytes;
  if (capOverride !== undefined && !(Number(capOverride) > 0)) return 'max_bytes must be a positive number';
  return conditionsProblem(rule.rule_v2);
}

function conditionsProblem(conditions, depth = 0) {
  if (!Array.isArray(conditions)) return 'rule_v2 must be an array of conditions';
  if (conditions.length === 0) return 'rule_v2 is empty (would never match)';
  if (depth > LIMITS.maxNestingDepth) return `nesting deeper than ${LIMITS.maxNestingDepth}`;
  if (conditions.length > LIMITS.maxConditionsPerRule) {
    return `more than ${LIMITS.maxConditionsPerRule} conditions`;
  }
  for (const c of conditions) {
    if (!c || typeof c !== 'object') return 'condition is not an object';
    if (Array.isArray(c.rules)) {
      const nested = conditionsProblem(c.rules, depth + 1);
      if (nested) return nested;
      continue; // a group carries no match of its own
    }
    const m = c.match;
    if (!m || typeof m !== 'object') return 'condition has no match object';
    if (typeof m.type !== 'string' || m.type === '') return 'match.type must be a non-empty string';
    if (m.type === 'regex') {
      if (typeof m.value !== 'string') return 'regex match.value must be a string';
      if (m.value.length > LIMITS.maxRegexLength) return `regex longer than ${LIMITS.maxRegexLength} chars`;
    } else if (typeof m.value === 'string' && m.value.length > LIMITS.maxValueLength) {
      return `match.value longer than ${LIMITS.maxValueLength} chars`;
    }
    if (m.match) {
      // array_key_value nests a sub-match; count it toward depth so a chain can't be unbounded.
      const nested = conditionsProblem([{ match: m.match }], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}
