import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateBundle } from '../../src/protect/rules/validate.js';
import {
  MATCH_TYPES,
  MUTATIONS,
  KEYED_SOURCES,
  EXACT_SOURCES,
  PARAMETERLESS_MATCH_TYPES,
  CLOSED_SOURCE_KEYS,
  parameterProblem,
  matchProblem,
  mutationsProblem,
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
  it('are the ones the engine implements', () => {
    // Both directions. A type in the engine and not the contract is a capability nobody can use; a type in
    // the contract and not the engine is a rule that passes validation and screens nothing.
    const implemented = new Set(caseLabelsIn(ENGINE, 'function matchValue', '\nexport function walkLeaves'));
    // The three whole-request primitives are handled before the switch, so they are not case labels.
    for (const type of PARAMETERLESS_MATCH_TYPES) {
      expect(ENGINE, `${type} should be implemented`).toContain(`match.type === '${type}'`);
      implemented.add(type);
    }

    expect([...implemented].sort()).toEqual([...MATCH_TYPES].sort());
  });
});

describe('the mutations the contract publishes', () => {
  it('are the ones the resolver implements', () => {
    const implemented = caseLabelsIn(RESOLVER, '#applyMutation(mutation, value)', '#resolveGet(key)');

    expect(implemented).toEqual([...MUTATIONS].sort());
  });
});

describe('the parameter sources the contract publishes', () => {
  it('are the ones the resolver switches on', () => {
    const implemented = caseLabelsIn(RESOLVER, 'switch (source)', '\n  // Response-phase sources');

    expect(implemented).toEqual([...KEYED_SOURCES].sort());
  });

  it('include every keyless source the resolver special-cases', () => {
    for (const source of EXACT_SOURCES) {
      expect(RESOLVER, `${source} should be resolved`).toContain(`parameter === '${source}'`);
    }
  });

  it('name the closed key sets the resolver really has', () => {
    for (const key of CLOSED_SOURCE_KEYS.egress) {
      expect(RESOLVER).toContain(`key === '${key}'`);
    }
    for (const key of CLOSED_SOURCE_KEYS.response) {
      expect(RESOLVER).toContain(`key === '${key}'`);
    }
  });
});

describe('what the contract refuses', () => {
  it('refuses a source the resolver has no case for', () => {
    // The reported vocabulary. Each of these resolves to nothing, so the rule ships and screens nothing.
    expect(parameterProblem('raw.file')).toMatch(/unknown parameter source/);
    expect(parameterProblem('raw.url')).toMatch(/unknown parameter source/);
    expect(parameterProblem('raw.id')).toMatch(/unknown parameter source/);
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
    for (const source of EXACT_SOURCES) expect(parameterProblem(source)).toBeNull();
  });

  it('accepts a keyed source with a key', () => {
    for (const parameter of ['get.q', 'post.title', 'request.id', 'cookie.session', 'server.HTTP_HOST', 'files.upload', 'egress.host', 'response.body']) {
      expect(parameterProblem(parameter), parameter).toBeNull();
    }
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
    for (const key of ['exact_sources', 'keyed_sources', 'match_types', 'parameterless_match_types', 'mutations', 'phases', 'actions', 'rule_properties']) {
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
    expect(reasonFor({ parameter: 'raw.file', match: { type: 'contains', value: 'x' } })).toMatch(/unknown parameter source/);
    expect(reasonFor({ parameter: 'get', match: { type: 'contains', value: 'x' } })).toMatch(/needs a key/);
    expect(reasonFor({ parameter: 'post', match: { type: 'contains', value: 'x' } })).toMatch(/needs a key/);
    expect(reasonFor({ parameter: 'raw', match: { type: 'not_a_type', value: 'x' } })).toMatch(/unknown match type/);
    expect(reasonFor({ parameter: 'raw', mutations: ['not_a_mutation'], match: { type: 'contains', value: 'x' } })).toMatch(/unknown mutation/);
    expect(reasonFor({ parameter: 'egress.hostname', match: { type: 'internal_host' } })).toMatch(/no key "hostname"/);
  });

  it('rejects a bad member of a parameter LIST, even beside good ones', () => {
    // How the dead vocabulary survived in this package's own default rules: `raw.file` sat in a list with
    // `get.file` and `post.file`, so the condition still fired through its siblings and the dead entry
    // looked like coverage.
    expect(reasonFor({ parameter: ['get.file', 'post.file', 'raw.file'], match: { type: 'contains', value: 'x' } }))
      .toMatch(/unknown parameter source/);
  });

  it('still accepts the shapes the engine runs', () => {
    // The control. A gate that rejected everything would be found immediately; one that rejects a little
    // too much is found by a customer whose rule silently stopped being enforced.
    expect(reasonFor({ parameter: 'get.q', match: { type: 'contains', value: 'x' } })).toBeNull();
    expect(reasonFor({ parameter: ['get.file', 'post.file'], match: { type: 'contains', value: 'x' } })).toBeNull();
    expect(reasonFor({ parameter: 'raw', mutations: ['urldecode', 'htmlentitydecode'], match: { type: 'regex', value: '/x/i' } })).toBeNull();
    expect(reasonFor({ match: { type: 'cross_origin' } })).toBeNull();
    expect(reasonFor({ parameter: 'response.body', match: { type: 'array_key_value', value: 'a.b', match: { type: 'contains', value: 'x' } } })).toBeNull();
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

