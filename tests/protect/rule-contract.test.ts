import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateBundle } from '../../src/protect/rules/validate.js';
import {
  MATCH_TYPES,
  MUTATIONS,
  SOURCES,
  PARAMETERLESS_MATCH_TYPES,
  parameterProblem,
  matchProblem,
  mutationsProblem,
  whenProblem,
  actionProblem,
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
    expect(actionProblem('set-header', {})).toBe('action "set-header" needs "set_headers"');
    expect(actionProblem('remove-header', {})).toBe('action "remove-header" needs "remove_headers"');
    expect(actionProblem('harden-cookie', {})).toBe('action "harden-cookie" needs "cookie_flags"');
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
      if (spec.keyed !== true) expect(parameterProblem(name), name).toBeNull();
    }
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
    expect(actionProblem('set-header', { set_headers: { 'X-Frame-Options': 'DENY' } })).toBeNull();
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

  it('rejects a scope the engine would ignore, at the gate', () => {
    // The gate, not the helper. Every guard added to the contract needs one of these: the functions can be
    // correct and unreferenced, and a scope the engine ignores makes the rule apply to every request.
    expect(ruleReasonFor({ when: { route: '/admin' }, rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'x' } }] }))
      .toMatch(/apply to every request/);
    expect(ruleReasonFor({ when: { path: '/admin' }, rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'x' } }] }))
      .toBeNull();
  });

  it('rejects an action missing its own properties, at the gate', () => {
    expect(ruleReasonFor({ action: 'set-header', rule_v2: [{ parameter: 'raw', match: { type: 'isset' } }] }))
      .toMatch(/needs "set_headers"/);
    expect(ruleReasonFor({ action: 'set-header', set_headers: { 'X-Frame-Options': 'DENY' }, rule_v2: [{ parameter: 'raw', match: { type: 'isset' } }] }))
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
