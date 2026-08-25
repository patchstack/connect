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

// Vocabulary, shape and bounds all come from the shared contract, so this file and the layers upstream of
// it are checking one description of what the engine runs.
import {
  ACTIONS as CONTRACT_ACTIONS,
  LIMITS as CONTRACT_LIMITS,
  PHASES as CONTRACT_PHASES,
  actionProblem,
  isGroup,
  matchProblem,
  mutationsProblem,
  parameterProblem,
  whenProblem,
} from './contract.js';

export const LIMITS = CONTRACT_LIMITS;

const PHASES = new Set(CONTRACT_PHASES);
const ACTIONS = new Set(CONTRACT_ACTIONS);

/**
 * Validate a delivered bundle. Returns `{ bundle, rejected }` where `bundle` contains only rules that
 * passed and `rejected` is `[{ id, reason }]` for everything dropped.
 * @param {object} bundle
 * @returns {{ bundle: object, rejected: Array<{id: string, reason: string}> }}
 */
export function validateBundle(bundle, opts = {}) {
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
    // One with no `rule_id` applies to EVERY rule — a single tripped condition disables the whole
    // firewall for that request — so it must be opted into explicitly.
    if (!opts.allowGlobalWhitelists && wl && Array.isArray(wl.rule_v2) && !wl.rule_id) {
      rejected.push({ id: idOf(wl), reason: 'whitelist has no rule_id (would suppress every rule); set allowGlobalWhitelists to permit' });
      continue;
    }
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

  // The action's own properties, not just its name: `set-header` without `set_headers` matches and then
  // does nothing, which reads as a rule that is enforced.
  const actionReason = actionProblem(rule.action, rule);
  if (actionReason) return actionReason;

  // An unrecognised scope key is IGNORED by the engine, so the rule applies to every request — a scope
  // authored to narrow a rule that instead widens it to everything.
  const scopeReason = whenProblem(rule.when);
  if (scopeReason) return scopeReason;

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

    // The engine recognises a group only as `{ parameter: 'rules', rules: [...] }`. Any other parameter
    // beside a `rules` array is a condition the engine resolves and then finds no match object on, so its
    // nested conditions are never evaluated.
    if (isGroup(c)) {
      const nested = conditionsProblem(c.rules, depth + 1);
      if (nested) return nested;
      continue; // a group carries no match of its own
    }
    if (Array.isArray(c.rules)) {
      return `condition carries nested rules but its parameter is ${JSON.stringify(c.parameter)}; a group must be {"parameter":"rules"}`;
    }
    // The vocabulary checks. Without them the only question asked was whether `match.type` was a
    // non-empty string, so an invented source, an invented match type and an invented mutation all passed
    // — and each of them produces a rule that is delivered, counted as protection, and never matches.
    const parameterReason = parameterProblem(c.parameter);
    if (parameterReason) return parameterReason;

    const mutationReason = mutationsProblem(c.mutations);
    if (mutationReason) return mutationReason;

    const matchReason = matchProblem(c.match, c.parameter);
    if (matchReason) return matchReason;

    const m = c.match;
    if (m.type === 'regex') {
      if (typeof m.value !== 'string') return 'regex match.value must be a string';
      if (m.value.length > LIMITS.maxRegexLength) return `regex longer than ${LIMITS.maxRegexLength} chars`;
    } else if (typeof m.value === 'string' && m.value.length > LIMITS.maxValueLength) {
      return `match.value longer than ${LIMITS.maxValueLength} chars`;
    }
    if (m.match) {
      // array_key_value nests a sub-match; count it toward depth so a chain can't be unbounded.
      //
      // The PARENT's parameter is carried down. The sub-match has none of its own — it applies to whatever
      // the key path navigated to — so validating it in isolation reported every one of them as a match
      // type missing a parameter, which would have rejected a shipped capability as malformed.
      const nested = conditionsProblem([{ parameter: c.parameter, match: m.match }], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}
