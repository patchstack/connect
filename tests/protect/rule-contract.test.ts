import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateBundle } from '../../src/protect/rules/validate.js';
import {
  MATCH_TYPES,
  MUTATIONS,
  SOURCES,
  PARAMETERLESS_MATCH_TYPES,
  OPERANDLESS_MATCH_TYPES,
  MATCH_OPERANDS,
  parameterProblem,
  matchProblem,
  mutationsProblem,
  whenProblem,
  actionProblem,
  conditionShapeProblem,
  isGroup,
  ruleContract,
} from '../../src/protect/rules/contract.js';

/**
 * The contract has to BE the engine's vocabulary, not a second opinion about it.
 *
 * A hand-maintained list of match types drifts from the switch that implements them, and the drift is
 * silent in the worst direction: a type the contract knows and the engine does not is a rule that
 * validates, ships, and never matches. So these tests read the engine's own source and compare. That is
 * coarse — it parses `case` labels — and it is the only thing here that cannot be satisfied by editing one
 * file, which is the property that matters.
 */
const ENGINE = readFileSync(new URL('../../src/protect/engine/engine.js', import.meta.url), 'utf8');
const RESOLVER = readFileSync(new URL('../../src/protect/engine/request.js', import.meta.url), 'utf8');

/** `case 'x':` labels inside a named method or function body. */
function caseLabelsIn(source: string, marker: string, endMarker: string): string[] {
  const start = source.indexOf(marker);
  expect(start, `marker ${marker} not found — this test is reading the wrong place`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  const body = source.slice(start, end === -1 ? undefined : end);

  // Digits included: `base64_decode` is a mutation, and a character class that omitted them silently
  // dropped it from the parsed set — a comparison that passed for the wrong reason.
  return [...body.matchAll(/case '([A-Za-z0-9_]+)':/g)].map((m) => m[1] as string).sort();
}

describe('the match types the contract publishes', () => {
  it('are the ones the engine EVALUATES', () => {
    // A `case` label is not a capability. `file_contains` has one and returns false unconditionally, so a
    // rule built on it can never match — publishing it would invite somebody to author one. The label set is
    // therefore the starting point and each member has to be shown to do something.
    const labelled = new Set(caseLabelsIn(ENGINE, 'function matchValue', '\nexport function walkLeaves'));
    for (const type of PARAMETERLESS_MATCH_TYPES) {
      expect(ENGINE, `${type} should be implemented`).toContain(`match.type === '${type}'`);
      labelled.add(type);
    }

    const inert = [...labelled].filter((type) => !MATCH_TYPES.includes(type));
    expect(inert, 'every labelled type is either published or a documented no-match').toEqual(['file_contains']);
    expect(ENGINE, 'file_contains should still be an explicit no-match').toMatch(/case 'file_contains':\s*\n\s*return false;/);

    for (const type of MATCH_TYPES) {
      expect(labelled.has(type), `${type} is published but has no branch`).toBe(true);
    }
  });

  it('publishes no matcher that always answers false', () => {
    // Behavioural, not a source read: a published type has to be able to say yes to something.
    for (const type of ['contains', 'equals', 'regex', 'isset']) {
      expect(MATCH_TYPES).toContain(type);
    }
    expect(MATCH_TYPES).not.toContain('file_contains');
  });
});

describe('the mutations the contract publishes', () => {
  it('are the ones the resolver implements', () => {
    const implemented = caseLabelsIn(RESOLVER, '#applyMutation(mutation, value)', '#resolveGet(key)');

    expect(implemented).toEqual([...MUTATIONS].sort());
  });
});

describe('the parameter sources the contract publishes', () => {
  it('are the ones the resolver switches on, plus the keyless ones it special-cases', () => {
    const keyed = caseLabelsIn(RESOLVER, 'switch (source)', '\n  // Response-phase sources');
    const publishedKeyed = Object.entries(SOURCES).filter(([, spec]) => spec.keyed === true).map(([name]) => name).sort();

    expect(keyed).toEqual(publishedKeyed);

    for (const [name, spec] of Object.entries(SOURCES)) {
      if (spec.keyed !== true) expect(RESOLVER, `${name} should be resolved`).toContain(`parameter === '${name}'`);
    }
  });

  it('describe the closed key sets exactly, including their prefixes', () => {
    // The prefix forms are the ones a plain list gets wrong in both directions: `response.header.<name>` is
    // supported and an exact list refuses it, while `server.<anything>` is refused by the resolver and an
    // open list accepts it.
    for (const key of SOURCES.response.keys as string[]) expect(RESOLVER).toContain(`key === '${key}'`);
    for (const prefix of SOURCES.response.key_prefixes as string[]) expect(RESOLVER).toContain(`key.startsWith('${prefix}')`);
    for (const key of SOURCES.egress.keys as string[]) expect(RESOLVER).toContain(`key === '${key}'`);
    for (const key of SOURCES.server.keys as string[]) expect(RESOLVER).toContain(`case '${key}':`);
    for (const prefix of SOURCES.server.key_prefixes as string[]) expect(RESOLVER).toContain(`key.startsWith('${prefix}')`);
  });
});

describe('the scope keys the contract publishes', () => {
  it('are the ones the engine evaluates', () => {
    expect(ENGINE).toContain('when.method');
    expect(ENGINE).toContain('when.path');
    expect(ruleContract().when_keys).toEqual(['path', 'method']);
  });
});

describe('the group shape the contract publishes', () => {
  it('is the one the engine recognises', () => {
    expect(ENGINE).toContain("parameter === 'rules' && Array.isArray(condition.rules)");
    expect(isGroup({ parameter: 'rules', rules: [] })).toBe(true);
    expect(isGroup({ parameter: 'raw', rules: [] })).toBe(false);
  });
});

describe('what the contract refuses', () => {
  it('refuses a source the resolver has no case for', () => {
    // The reported vocabulary. Each of these resolves to nothing, so the rule ships and screens nothing.
    // `raw` is real and keyless, so the precise complaint is the key, not the source.
    expect(parameterProblem('raw.file')).toBe('source "raw" takes no key');
    expect(parameterProblem('raw.url')).toBe('source "raw" takes no key');
    expect(parameterProblem('raw.id')).toBe('source "raw" takes no key');
    expect(parameterProblem('nonsense.field')).toMatch(/unknown parameter source/);
  });

  it('refuses a keyed source used without a key, and says what is missing', () => {
    // `get` and `post` look like sources. The resolver needs a key to look anything up, so bare they
    // resolve to nothing — and the message has to name the fix, because the author thought this was valid.
    expect(parameterProblem('get')).toBe('source "get" needs a key, e.g. "get.fieldname"');
    expect(parameterProblem('post')).toBe('source "post" needs a key, e.g. "post.fieldname"');
    expect(parameterProblem('server.')).toMatch(/needs a key after the dot/);
  });

  it('refuses a key a closed source does not have', () => {
    expect(parameterProblem('egress.hostname')).toMatch(/no key "hostname"/);
    expect(parameterProblem('response.cookies')).toMatch(/no key "cookies"/);
    // The one an open list let through: the resolver answers for named keys and the `HTTP_` prefix only.
    expect(parameterProblem('server.ANYTHING_AT_ALL')).toMatch(/no key "ANYTHING_AT_ALL"/);
  });

  it('refuses a scope that would silently widen the rule', () => {
    expect(whenProblem({ route: '/admin' })).toMatch(/apply to every request/);
    expect(whenProblem({})).toMatch(/when is empty/);
  });

  it('refuses an action whose own properties are missing', () => {
    expect(actionProblem('set-header', { phase: 'response' })).toBe('action "set-header" needs "set_headers"');
    expect(actionProblem('remove-header', { phase: 'response' })).toBe('action "remove-header" needs "remove_headers"');
  });

  it('refuses a header action on a phase that cannot carry it out', () => {
    // A header mutation is applied on the response. On the request phase the rule is not a header mutation
    // at all — it falls through to the blocking path and answers 403, which is the opposite of hardening.
    expect(actionProblem('set-header', { set_headers: { 'X-Frame-Options': 'DENY' } }))
      .toMatch(/carried out on the response phase/);
    expect(actionProblem('harden-cookie', { phase: 'request' })).toMatch(/carried out on the response phase/);
    expect(actionProblem('redact', { phase: 'request' })).toMatch(/carried out on the response phase/);
  });

  it('does not require a property the runtime supplies', () => {
    // `harden-cookie` applies HttpOnly, Secure and SameSite=Lax by itself, so requiring `cookie_flags`
    // would drop a rule that works.
    expect(actionProblem('harden-cookie', { phase: 'response' })).toBeNull();
    expect(ruleContract().action_properties['harden-cookie'].defaulted).toContain('cookie_flags');
  });

  it('refuses a scope whose value the engine cannot use', () => {
    // Both directions, because a malformed scope fails in both: an empty string is falsy so the check is
    // skipped and the rule applies everywhere, while an empty list or a non-string matches nothing.
    expect(whenProblem({ path: '' })).toMatch(/non-empty string/);
    expect(whenProblem({ method: '' })).toMatch(/non-empty string/);
    expect(whenProblem({ method: [] })).toMatch(/empty list/);
    expect(whenProblem({ path: 42 })).toMatch(/non-empty string/);
    expect(whenProblem({ method: ['POST', ''] })).toMatch(/non-empty string/);
  });

  it('refuses a wildcard on a source that does not fan out', () => {
    expect(parameterProblem('egress.hos*')).toMatch(/does not fan out/);
    expect(parameterProblem('response.head*')).toMatch(/does not fan out/);
    expect(parameterProblem('server.HTTP_*')).toMatch(/does not fan out/);
  });

  it('refuses a group that is not a whole group', () => {
    expect(conditionShapeProblem({ parameter: 'rules' })).toMatch(/needs a "rules" array/);
    expect(conditionShapeProblem({ parameter: 'rules', rules: [] })).toMatch(/no conditions/);
    expect(conditionShapeProblem({ parameter: 'rules', rules: [{ parameter: 'raw', match: { type: 'isset' } }], match: { type: 'isset' } }))
      .toMatch(/carries no match of its own/);
  });

  it('refuses hostname without the value it compares against', () => {
    // `hostname` tests `url.hostname === match.value`, so with no value it can only be false.
    expect(matchProblem({ type: 'hostname' }, 'server.HTTP_HOST')).toMatch(/needs "value"/);
    expect(matchProblem({ type: 'hostname', value: 'evil.test' }, 'server.HTTP_HOST')).toBeNull();
  });

  it('refuses an incomplete array_key_value', () => {
    expect(matchProblem({ type: 'array_key_value', key: 'a.b' }, 'raw')).toMatch(/needs "match"/);
    expect(matchProblem({ type: 'array_key_value', match: { type: 'contains', value: 'x' } }, 'raw')).toMatch(/needs "key"/);
  });

  it('refuses a parameter on a whole-request primitive', () => {
    expect(matchProblem({ type: 'cross_origin' }, 'raw')).toMatch(/takes no parameter/);
  });

  it('refuses a match type the engine does not implement', () => {
    expect(matchProblem({ type: 'definitely_not_a_type' }, 'raw')).toBe('unknown match type "definitely_not_a_type"');
  });

  it('refuses a mutation the resolver does not implement', () => {
    // Worse than an unknown match type: an unknown mutation is a silent no-op, so the condition still runs
    // — against the untransformed value. The rule then checks something other than what it says.
    //
    // `htmlentitydecode` used to be exactly that: documented, used by a shipped rule, unimplemented. It is
    // implemented now, so the case here is a name that has never existed.
    expect(mutationsProblem(['htmlentitydecode'])).toBeNull();
    expect(mutationsProblem(['definitely_not_a_mutation'])).toMatch(/unknown mutation "definitely_not_a_mutation"/);
    expect(mutationsProblem(['urldecode', 'nope'])).toMatch(/unknown mutation "nope"/);
  });

  it('requires a parameter for a match type that resolves one', () => {
    expect(matchProblem({ type: 'contains', value: 'x' }, undefined)).toMatch(/needs a parameter/);
  });
});

describe('what the contract accepts', () => {
  it('accepts the keyless sources', () => {
    for (const [name, spec] of Object.entries(SOURCES)) {
      // The group source is keyless but is not a parameter: it names a group, and the resolver has no
      // value for it. It is validated as a group shape instead — see the group tests.
      if (spec.keyed !== true && spec.group !== true) expect(parameterProblem(name), name).toBeNull();
    }
    expect(Object.values(SOURCES).filter((spec) => spec.group === true)).toHaveLength(1);
  });

  it('accepts a keyed source with a key', () => {
    for (const parameter of [
      'get.q', 'post.title', 'request.id', 'cookie.session',
      'server.HTTP_HOST', 'server.HTTP_X_CUSTOM', 'server.REQUEST_URI',
      'files.upload', 'files.upload.content', 'files.docs*',
      'egress.host', 'response.body',
      // The prefix form an exact list refused.
      'response.header.x-api-key',
      // The wildcard form the resolver fans out over.
      'get.field*',
    ]) {
      expect(parameterProblem(parameter), parameter).toBeNull();
    }
  });

  it('accepts the scopes and actions the engine honours', () => {
    expect(whenProblem({ path: '/admin' })).toBeNull();
    expect(whenProblem({ path: '/api/*', method: ['POST', 'PUT'] })).toBeNull();
    expect(actionProblem('block', {})).toBeNull();
    expect(actionProblem('set-header', { phase: 'response', set_headers: { 'X-Frame-Options': 'DENY' } })).toBeNull();
  });

  it('accepts a whole-request primitive with NO parameter', () => {
    // The inverse of the SaaS problem: requiring a parameter on every condition makes every CSRF and
    // open-redirect rule permanently unimportable, while looking like the rule is malformed.
    for (const type of PARAMETERLESS_MATCH_TYPES) {
      expect(matchProblem({ type }, undefined), type).toBeNull();
    }
  });

  it('accepts every condition in the shipped rule bundle', () => {
    // The control that keeps the contract from being too strict to use: whatever this package ships as its
    // fallback rules must pass its own contract.
    const bundle = JSON.parse(readFileSync(new URL('../../src/protect/templates/rules.json', import.meta.url), 'utf8'));
    const walk = (conditions: any[], ruleId: string): void => {
      for (const condition of conditions ?? []) {
        if (Array.isArray(condition.rules)) {
          walk(condition.rules, ruleId);
          continue;
        }
        expect(parameterProblem(condition.parameter), `${ruleId}: ${condition.parameter}`).toBeNull();
        expect(matchProblem(condition.match, condition.parameter), `${ruleId}: ${JSON.stringify(condition.match)}`).toBeNull();
        expect(mutationsProblem(condition.mutations), `${ruleId}: ${JSON.stringify(condition.mutations)}`).toBeNull();
      }
    };
    for (const rule of [...(bundle.firewall ?? []), ...(bundle.whitelists ?? [])]) {
      walk(rule.rule_v2, String(rule.id ?? rule.rule_id));
    }
  });
});

describe('the published contract document', () => {
  it('carries a version and every list a consumer needs', () => {
    const contract = ruleContract();

    expect(contract.version).toMatch(/^\d+\.\d+$/);
    for (const key of ['sources', 'match_types', 'parameterless_match_types', 'operandless_match_types', 'match_operands', 'mutations', 'phases', 'actions', 'action_properties', 'when_keys', 'rule_properties', 'limits']) {
      expect(contract, key).toHaveProperty(key);
      expect((contract as Record<string, unknown>)[key], key).not.toEqual([]);
    }
  });
});

describe('what the delivered-bundle validator does with it', () => {
  /** @returns the reason the rule was rejected, or null when it was accepted. */
  function reasonFor(condition: Record<string, unknown>): string | null {
    const { bundle, rejected } = validateBundle({
      firewall: [{ id: 'probe', rule_v2: [condition] }],
      whitelists: [],
    } as never);

    return bundle.firewall.length === 1 ? null : (rejected[0]?.reason ?? 'rejected without a reason');
  }

  it('rejects every invalid shape at the gate, not just in the helper', () => {
    // The wiring, not the definition. The contract functions can be perfect and unused: reverting
    // `validate.js` to its old shape-only check left every other test in this file green while the gate
    // accepted all of this again. So the assertion is on the validator's own answer.
    expect(reasonFor({ parameter: 'raw.file', match: { type: 'contains', value: 'x' } })).toMatch(/takes no key/);
    expect(reasonFor({ parameter: 'get', match: { type: 'contains', value: 'x' } })).toMatch(/needs a key/);
    expect(reasonFor({ parameter: 'post', match: { type: 'contains', value: 'x' } })).toMatch(/needs a key/);
    expect(reasonFor({ parameter: 'raw', match: { type: 'not_a_type', value: 'x' } })).toMatch(/unknown match type/);
    expect(reasonFor({ parameter: 'raw', mutations: ['not_a_mutation'], match: { type: 'contains', value: 'x' } })).toMatch(/unknown mutation/);
    expect(reasonFor({ parameter: 'egress.hostname', match: { type: 'internal_host' } })).toMatch(/no key "hostname"/);
  });

  /** @returns the reason the RULE was rejected, or null. Rule-level properties, not one condition. */
  function ruleReasonFor(rule: Record<string, unknown>): string | null {
    const { bundle, rejected } = validateBundle({
      firewall: [{ id: 'probe', ...rule }],
      whitelists: [],
    } as never);

    return bundle.firewall.length === 1 ? null : (rejected[0]?.reason ?? 'rejected without a reason');
  }

  it('rejects an unusable scope value and an inert group, at the gate', () => {
    const leaf = { parameter: 'get.q', match: { type: 'contains', value: 'x' } };

    expect(ruleReasonFor({ when: { path: '' }, rule_v2: [leaf] })).toMatch(/non-empty string/);
    expect(ruleReasonFor({ when: { method: [] }, rule_v2: [leaf] })).toMatch(/empty list/);
    expect(reasonFor({ parameter: 'rules' })).toMatch(/needs a "rules" array/);
    expect(reasonFor({ parameter: 'rules', rules: [leaf], match: { type: 'isset' } })).toMatch(/carries no match/);
    expect(reasonFor({ parameter: 'egress.hos*', match: { type: 'isset' } })).toMatch(/does not fan out/);
    expect(reasonFor({ parameter: 'server.HTTP_HOST', match: { type: 'hostname' } })).toMatch(/needs "value"/);
  });

  it('rejects the group source used as a parameter, at the gate', () => {
    // `rules` names a group, and the resolver answers it with nothing. As a leaf parameter it is a
    // condition that resolves no value and tests it — inert. Beside a real parameter it is worse: the
    // working sibling carries the match, so the dead half is invisible.
    const match = { type: 'contains', value: '<script' };

    // Bare, it is rejected one step earlier — as a group missing its `rules` array.
    expect(reasonFor({ parameter: 'rules', match })).toMatch(/is a group and needs a "rules" array/);
    // Inside a list there is no group shape to recognise, so this is the case the parameter rule covers.
    expect(reasonFor({ parameter: ['get.q', 'rules'], match })).toMatch(/only valid as a whole group/);
    expect(reasonFor({ parameter: ['rules'], match })).toMatch(/only valid as a whole group/);

    // ...and the real group form is untouched by that. This is the regression guard for the above:
    // a group is recognised before parameter validation, so rejecting `rules` there must not reach it.
    expect(reasonFor({ parameter: 'rules', rules: [{ parameter: 'get.q', match }] })).toBeNull();
  });

  it('rejects operands that cannot match, and operands that match everything, at the gate', () => {
    // Presence of the operand is not the property that matters — usability is. Each of these was
    // accepted by the required-fields-only gate, and each was measured against the engine:
    //   inert (never fires):        array_key_value key [], regex '', regex '//', undelimited regex
    //   fires on ALL traffic:       contains '', stripos ''
    // The second group is the dangerous direction: an empty substring is contained in every value, so
    // the rule blocks every request while reading as one targeted signature.
    expect(reasonFor({ parameter: 'post.a', match: { type: 'array_key_value', key: [], match: { type: 'contains', value: 'x' } } }))
      .toMatch(/operand "key" must be a non-empty string, or a non-empty list of them/);
    expect(reasonFor({ parameter: 'post.a', match: { type: 'array_key_value', key: ['a', ''], match: { type: 'contains', value: 'x' } } }))
      .toMatch(/operand "key"/);
    expect(reasonFor({ parameter: 'post.a', match: { type: 'array_key_value', key: 'a.b', match: 'not-an-object' } }))
      .toMatch(/operand "match" must be an object/);

    expect(reasonFor({ parameter: 'get.q', match: { type: 'regex', value: '' } })).toMatch(/must be a non-empty string/);
    expect(reasonFor({ parameter: 'get.q', match: { type: 'regex', value: '//' } })).toMatch(/must be a delimited pattern/);
    expect(reasonFor({ parameter: 'get.q', match: { type: 'regex', value: '<script' } })).toMatch(/must be a delimited pattern/);
    // The length limit has its own owner at the gate — asserted here so the two checks stay compatible.
    expect(reasonFor({ parameter: 'get.q', match: { type: 'regex', value: `/${'a'.repeat(1200)}/` } })).toMatch(/regex longer than 1000/);

    for (const type of ['contains', 'stripos', 'not_contains']) {
      expect(reasonFor({ parameter: 'get.q', match: { type, value: '' } })).toMatch(/must be a non-empty string/);
      expect(reasonFor({ parameter: 'get.q', match: { type, value: '   ' } })).toMatch(/must be a non-empty string/);
    }

    // The shapes must not have moved past what the engine accepts: these all work today.
    expect(reasonFor({ parameter: 'get.q', match: { type: 'regex', value: '/<script/i' } })).toBeNull();
    expect(reasonFor({ parameter: 'get.q', match: { type: 'contains', value: '<script' } })).toBeNull();
    expect(reasonFor({ parameter: 'post.a', match: { type: 'array_key_value', key: 'a.b', match: { type: 'contains', value: 'x' } } })).toBeNull();
    expect(reasonFor({ parameter: 'post.a', match: { type: 'array_key_value', key: ['a.b', 'c'], match: { type: 'contains', value: 'x' } } })).toBeNull();
    // `equals` against an empty value is a real signature (the parameter IS empty), not a degenerate one.
    expect(reasonFor({ parameter: 'get.q', match: { type: 'equals', value: '' } })).toBeNull();
  });

  it('rejects an unusable operand on every matcher that reads one, at the gate', () => {
    // The same property as the substring matchers, applied to the rest of the operand-bearing set, so
    // "every required operand has a usable shape" holds for the whole vocabulary rather than the part
    // that had been looked at. Measured against the engine:
    //   hostname '':        compares to `new URL(v).hostname`, so it equals only the empty hostname of
    //                       an opaque-scheme URL (file:, mailto:, data:) — never a host, and a false
    //                       positive on those. Not inert, which is why it is worth refusing.
    //   in_array []:        inert.
    //   not_in_array []:    true for EVERY value — the blocks-all-traffic direction again.
    //   array_in_array []:  inert; a bare scalar never matches either, since it compares array to array.
    expect(reasonFor({ parameter: 'get.q', match: { type: 'hostname', value: '' } })).toMatch(/must be a non-empty string/);
    expect(reasonFor({ parameter: 'get.list', match: { type: 'in_array', value: [] } })).toMatch(/must be a scalar, or a non-empty list/);
    expect(reasonFor({ parameter: 'get.list', match: { type: 'not_in_array', value: [] } })).toMatch(/must be a scalar, or a non-empty list/);
    expect(reasonFor({ parameter: 'get.list', match: { type: 'array_in_array', value: [] } })).toMatch(/must be a non-empty list of scalars/);
    expect(reasonFor({ parameter: 'get.list', match: { type: 'array_in_array', value: 'admin' } })).toMatch(/must be a non-empty list of scalars/);

    // The shapes stay no stricter than the runtime. Every one of these matches today: the membership
    // matchers stringify their entries, so numbers and booleans are usable; a bare scalar is wrapped
    // into a one-element list; and `['']` is a real signature — "this parameter is empty".
    expect(reasonFor({ parameter: 'get.q', match: { type: 'hostname', value: 'evil.test' } })).toBeNull();
    expect(reasonFor({ parameter: 'get.list', match: { type: 'in_array', value: [1, 2] } })).toBeNull();
    expect(reasonFor({ parameter: 'get.list', match: { type: 'in_array', value: [true] } })).toBeNull();
    expect(reasonFor({ parameter: 'get.list', match: { type: 'in_array', value: 'admin' } })).toBeNull();
    expect(reasonFor({ parameter: 'get.list', match: { type: 'in_array', value: [''] } })).toBeNull();
    expect(reasonFor({ parameter: 'get.list', match: { type: 'not_in_array', value: ['user'] } })).toBeNull();
    expect(reasonFor({ parameter: 'get.list', match: { type: 'array_in_array', value: [1] } })).toBeNull();

    // The comparison family, which the completeness check below is what surfaced. Measured:
    //   equals_strict 10 vs q=10 -> false, while '10' -> true. The subject is stringified before the
    //     type-strict compare, so a number operand is unconditionally inert.
    //   less_than/more_than 'abc' -> false in BOTH directions: `Number('abc')` is NaN.
    expect(reasonFor({ parameter: 'get.q', match: { type: 'equals_strict', value: 10 } })).toMatch(/type-strict/);
    expect(reasonFor({ parameter: 'get.q', match: { type: 'less_than', value: 'abc' } })).toMatch(/must be a number/);
    expect(reasonFor({ parameter: 'get.q', match: { type: 'more_than', value: 'abc' } })).toMatch(/must be a number/);
    expect(reasonFor({ parameter: 'get.q', match: { type: 'equals', value: {} } })).toMatch(/must be a string, number or boolean/);

    // `equals` coerces, so a number operand there DOES match a numeric string — refusing it would
    // break a working rule. And `more_than: ''` is `> 0`, a real threshold, so `numeric` admits it.
    expect(reasonFor({ parameter: 'get.q', match: { type: 'equals', value: 10 } })).toBeNull();
    expect(reasonFor({ parameter: 'get.q', match: { type: 'equals_strict', value: '10' } })).toBeNull();
    expect(reasonFor({ parameter: 'get.q', match: { type: 'less_than', value: 10 } })).toBeNull();
    expect(reasonFor({ parameter: 'get.q', match: { type: 'more_than', value: '' } })).toBeNull();
  });

  it('leaves no operand-bearing matcher without a declared shape', () => {
    // The reason the previous round missed `hostname` and the membership family: the shapes were added
    // one reported matcher at a time. This closes over the vocabulary instead — a match type that reads
    // an operand and has no shape is the next hole, so it fails here rather than in review.
    const readsAnOperand = MATCH_TYPES.filter((type) => !OPERANDLESS_MATCH_TYPES.includes(type));
    const undeclared = readsAnOperand.filter((type) => {
      const shapes = MATCH_OPERANDS[type]?.shapes;
      return !shapes || Object.keys(shapes).length === 0;
    });

    expect(undeclared, `these match types read an operand with no shape declared: ${undeclared.join(', ')}`)
      .toEqual([]);
  });

  it('rejects a header action whose payload mutates nothing, at the gate', () => {
    // The action name is the claim; the payload is the mutation. An empty one leaves a rule that
    // matches, reports a detection, and changes no header.
    const cond = { parameter: 'response.status', match: { type: 'isset' } };

    expect(ruleReasonFor({ phase: 'response', action: 'set-header', set_headers: {}, rule_v2: [cond] }))
      .toMatch(/"set_headers" must be an object with at least one entry/);
    expect(ruleReasonFor({ phase: 'response', action: 'set-header', set_headers: ['X-Frame-Options'], rule_v2: [cond] }))
      .toMatch(/"set_headers" must be an object/);
    expect(ruleReasonFor({ phase: 'response', action: 'remove-header', remove_headers: [], rule_v2: [cond] }))
      .toMatch(/"remove_headers" must be a non-empty list of HTTP header names/);
    expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', cookie_flags: 'httponly', rule_v2: [cond] }))
      .toMatch(/"cookie_flags" must be an object/);

    // `harden-cookie` names three flags and every one can be turned off, so an object-shaped payload is
    // not evidence the action does anything. Measured against `hardenCookie` — with all three off, the
    // cookie comes out byte-identical: `sid=abc; Path=/` in, `sid=abc; Path=/` out.
    expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', cookie_flags: { httpOnly: false, secure: false, sameSite: false }, rule_v2: [cond] }))
      .toMatch(/turns off every flag, so it would harden nothing/);

    // Each flag must say what it means. The runtime only tests truthiness, so `'false'` — or any other
    // non-boolean — would turn a flag ON while reading as off.
    expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', cookie_flags: { httpOnly: 'false' }, rule_v2: [cond] }))
      .toMatch(/flag "httpOnly" must be true or false/);
    expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', cookie_flags: { secure: 0 }, rule_v2: [cond] }))
      .toMatch(/flag "secure" must be true or false/);

    // An unknown key is silently ignored, so a near-miss reads as disabling a flag and leaves it on.
    expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', cookie_flags: { httponly: false }, rule_v2: [cond] }))
      .toMatch(/has no flag named "httponly"/);
    expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', cookie_flags: { sameSite: 'Lax', extra: true }, rule_v2: [cond] }))
      .toMatch(/has no flag named "extra"/);

    // `sameSite` is interpolated into the header, so an unrecognised value is ignored by the browser
    // and a value carrying `;` appends further cookie attributes.
    expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', cookie_flags: { sameSite: 'Banana' }, rule_v2: [cond] }))
      .toMatch(/flag "sameSite" must be false, or one of Strict, Lax, None/);
    expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', cookie_flags: { sameSite: 'Lax; Domain=evil.test' }, rule_v2: [cond] }))
      .toMatch(/flag "sameSite"/);
    expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', cookie_flags: { sameSite: true }, rule_v2: [cond] }))
      .toMatch(/flag "sameSite"/);

    // Turning off SOME defaults stays valid — that is a reviewer's call, and something still hardens.
    for (const flags of [
      { httpOnly: false, secure: false },        // -> SameSite=Lax only
      { httpOnly: true, secure: false, sameSite: false }, // -> HttpOnly only
      { sameSite: false },                       // -> HttpOnly; Secure
      {},                                        // -> all three defaults
      { sameSite: 'Strict' }, { sameSite: 'None' }, { sameSite: 'lax' },
    ]) {
      expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', cookie_flags: flags, rule_v2: [cond] }), JSON.stringify(flags))
        .toBeNull();
    }

    // A non-empty payload is not enough: the NAME has to be one the platform's `Headers` accepts. An
    // invalid one makes get/set/delete throw, the runtime skips the mutation, and a reviewed hardening
    // rule is served while changing nothing. `\n` is the worst of them — it reads as header injection
    // and is silently dropped instead.
    for (const name of ['', 'x bad', 'x:bad', 'x-bad\nInjected', 'x(bad)', 'x/bad']) {
      expect(ruleReasonFor({ phase: 'response', action: 'set-header', set_headers: { [name]: 'x' }, rule_v2: [cond] }), name)
        .toMatch(/names an invalid HTTP header/);
      expect(ruleReasonFor({ phase: 'response', action: 'remove-header', remove_headers: [name], rule_v2: [cond] }), name)
        .toMatch(/names an invalid HTTP header/);
    }

    // ...and the token characters a real header name may contain stay accepted.
    for (const name of ['X-Frame-Options', 'x-powered-by', 'Content-Security-Policy-Report-Only', "x'weird*chars!"]) {
      expect(ruleReasonFor({ phase: 'response', action: 'set-header', set_headers: { [name]: 'x' }, rule_v2: [cond] }), name).toBeNull();
      expect(ruleReasonFor({ phase: 'response', action: 'remove-header', remove_headers: [name], rule_v2: [cond] }), name).toBeNull();
    }

    // The working payloads stay working — including `harden-cookie` with no `cookie_flags` at all,
    // which the runtime defaults.
    expect(ruleReasonFor({ phase: 'response', action: 'set-header', set_headers: { 'X-Frame-Options': 'DENY' }, rule_v2: [cond] })).toBeNull();
    expect(ruleReasonFor({ phase: 'response', action: 'remove-header', remove_headers: ['X-Powered-By'], rule_v2: [cond] })).toBeNull();
    expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', rule_v2: [cond] })).toBeNull();
    expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', cookie_flags: { httpOnly: true }, rule_v2: [cond] })).toBeNull();
  });

  it('rejects a scope the engine would ignore, at the gate', () => {
    // The gate, not the helper. Every guard added to the contract needs one of these: the functions can be
    // correct and unreferenced, and a scope the engine ignores makes the rule apply to every request.
    expect(ruleReasonFor({ when: { route: '/admin' }, rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'x' } }] }))
      .toMatch(/apply to every request/);
    expect(ruleReasonFor({ when: { path: '/admin' }, rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'x' } }] }))
      .toBeNull();
  });

  it('rejects an action missing its own properties, at the gate', () => {
    expect(ruleReasonFor({ phase: 'response', action: 'set-header', rule_v2: [{ parameter: 'raw', match: { type: 'isset' } }] }))
      .toMatch(/needs "set_headers"/);
    expect(ruleReasonFor({ phase: 'response', action: 'set-header', set_headers: { 'X-Frame-Options': 'DENY' }, rule_v2: [{ parameter: 'raw', match: { type: 'isset' } }] }))
      .toBeNull();
    // The phase half, at the gate: a request-phase header rule blocks instead of setting a header.
    expect(ruleReasonFor({ action: 'set-header', set_headers: { 'X-Frame-Options': 'DENY' }, rule_v2: [{ parameter: 'raw', match: { type: 'isset' } }] }))
      .toMatch(/carried out on the response phase/);
    // And the defaulted property is not demanded.
    expect(ruleReasonFor({ phase: 'response', action: 'harden-cookie', rule_v2: [{ parameter: 'raw', match: { type: 'isset' } }] }))
      .toBeNull();
  });

  it('rejects a group whose parameter is not the one the engine recognises', () => {
    const nested = [{ parameter: 'get.q', match: { type: 'contains', value: 'x' } }];

    expect(reasonFor({ parameter: 'raw', rules: nested })).toMatch(/a group must be/);
    expect(reasonFor({ parameter: 'rules', rules: nested })).toBeNull();
  });

  it('rejects an incomplete array_key_value, at the gate', () => {
    expect(reasonFor({ parameter: 'raw', match: { type: 'array_key_value', key: 'a.b' } })).toMatch(/needs "match"/);
    expect(reasonFor({ parameter: 'raw', match: { type: 'array_key_value', match: { type: 'contains', value: 'x' } } })).toMatch(/needs "key"/);
  });

  it('accepts a valid prefixed source at the gate, and refuses an open one', () => {
    expect(reasonFor({ parameter: 'response.header.x-api-key', match: { type: 'contains', value: 'sk-' } })).toBeNull();
    expect(reasonFor({ parameter: 'server.HTTP_X_CUSTOM', match: { type: 'isset' } })).toBeNull();
    expect(reasonFor({ parameter: 'server.ANYTHING_AT_ALL', match: { type: 'isset' } })).toMatch(/no key "ANYTHING_AT_ALL"/);
  });

  it('rejects a bad member of a parameter LIST, even beside good ones', () => {
    // How the dead vocabulary survived in this package's own default rules: `raw.file` sat in a list with
    // `get.file` and `post.file`, so the condition still fired through its siblings and the dead entry
    // looked like coverage.
    expect(reasonFor({ parameter: ['get.file', 'post.file', 'raw.file'], match: { type: 'contains', value: 'x' } }))
      .toMatch(/takes no key/);
  });

  it('still accepts the shapes the engine runs', () => {
    // The control. A gate that rejected everything would be found immediately; one that rejects a little
    // too much is found by a customer whose rule silently stopped being enforced.
    expect(reasonFor({ parameter: 'get.q', match: { type: 'contains', value: 'x' } })).toBeNull();
    expect(reasonFor({ parameter: ['get.file', 'post.file'], match: { type: 'contains', value: 'x' } })).toBeNull();

    // The positive half of the wildcard rule. These carry a complete match on purpose: written without
    // one they are rejected for the missing match and would "pass" a `not.toBeNull()` check while
    // saying nothing about wildcards. Every source declaring `wildcard` has to survive the gate.
    for (const source of ['get', 'post', 'request', 'cookie', 'files']) {
      expect(reasonFor({ parameter: `${source}.q*`, match: { type: 'contains', value: 'x' } })).toBeNull();
    }
    expect(reasonFor({ parameter: 'raw', mutations: ['urldecode', 'htmlentitydecode'], match: { type: 'regex', value: '/x/i' } })).toBeNull();
    expect(reasonFor({ match: { type: 'cross_origin' } })).toBeNull();
    expect(reasonFor({ parameter: 'response.body', match: { type: 'array_key_value', key: 'a.b', match: { type: 'contains', value: 'x' } } })).toBeNull();
  });

  it('accepts every rule in the shipped bundles through the real gate', () => {
    // Both bundles, end to end. `rules.json` is what an offline install enforces and `demo-rules.json` is
    // what `--demo` seeds; a rule rejected here is one that silently stops being enforced.
    for (const file of ['../../src/protect/templates/rules.json', '../../src/protect/templates/demo-rules.json']) {
      const bundle = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
      const { rejected } = validateBundle(bundle);
      expect(rejected, `${file}: ${JSON.stringify(rejected)}`).toEqual([]);
    }
  });
});
