// The parameters a rule reads, from its own definition.
//
// One answer, in one place, for two callers that must not disagree: detection reporting names them in
// `parameters`, and the capture plan decides which values a matched rule is permitted to show. The two
// must describe the same set, or a report names parameters a rule does not read, or omits ones it does.
//
// NOT "the condition that matched": the engine reports a rule, not which of its conditions fired, and
// threading that out would mean changing evaluation for the sake of a reporting field. A narrowly scoped
// rule reads exactly one parameter, so the two answers coincide there; for a broad rule this is the set
// it reads, which is what the field name says.

import { LIMITS } from './rules/contract.js';

/**
 * Every parameter a rule reads, and whether the walk saw all of it.
 *
 * The walk stops at the contract's nesting bound, and a rule can reach the runtime without having been
 * validated against it: `responseRules` handed straight to the runtime are not checked, and neither is a
 * bundle from anywhere but the platform.
 *
 * `complete` is what a caller needs to tell a short list from a whole one. A caller that reads the list
 * to decide what a rule is ALLOWED to do must treat an incomplete list as no answer, because a condition
 * below the bound is absent from it and a set missing one looks exactly like a rule that never had it.
 * A caller that only describes the rule can use the list as it is.
 *
 * The bound comes from the contract rather than a constant here, so the walk stops where validation says
 * a rule ends.
 *
 * @param {any} rule
 * @returns {{ parameters: string[], complete: boolean }}
 */
export function readRuleParameters(rule) {
  const out = new Set();
  let complete = true;

  // `rules` is a grouping wrapper rather than a request region, so naming it would report a thing the
  // engine does not read.
  const add = (parameter) => {
    if (typeof parameter === 'string' && parameter !== 'rules') out.add(parameter);
  };

  // A condition may name one parameter or a list of them, and the engine reads every member of a list.
  // One level, because the engine expands one level: a nested list resolves to nothing there, so
  // flattening it would name a parameter no match can read.
  const collect = (parameter) => {
    if (Array.isArray(parameter)) {
      for (const member of parameter) add(member);

      return;
    }
    add(parameter);
  };

  const walk = (conditions, depth) => {
    if (!Array.isArray(conditions)) return;
    if (depth > LIMITS.maxNestingDepth) {
      complete = false;

      return;
    }
    for (const condition of conditions) {
      if (!condition || typeof condition !== 'object') continue;
      collect(condition.parameter);
      if (Array.isArray(condition.rules)) walk(condition.rules, depth + 1);
    }
  };

  walk(rule?.rule_v2, 0);

  return { parameters: [...out], complete };
}

/**
 * The parameters a rule reads, for callers that describe rather than gate.
 *
 * A short list understates the rule for both of them, which is the safe direction: a report names fewer
 * parameters, and a plan permits fewer values. A caller deciding what a rule may DO needs
 * `readRuleParameters` and its `complete` flag instead.
 *
 * @param {any} rule
 * @returns {string[]}
 */
export function ruleParameters(rule) {
  return readRuleParameters(rule).parameters;
}
