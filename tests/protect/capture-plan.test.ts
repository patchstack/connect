import { describe, it, expect } from 'vitest';
import {
  CAPTURE_LIMITS,
  createPlanCache,
  derivePlan,
  permitsAnything,
  planReference,
} from '../../src/protect/capture-plan.js';
import { validateBundle } from '../../src/protect/rules/validate.js';
import { captureProblem, ruleContract } from '../../src/protect/rules/contract.js';

/**
 * What a rule permits to be captured, and — mostly — what it does not.
 *
 * The interesting direction is refusal. A rule earns each permission by naming what it reads, so the
 * cases that matter are the ones where a rule reads broadly and must therefore permit nothing: those are
 * where a capture policy quietly turns a security channel into a copy of an application's traffic.
 */
const leafFor = (parameter: string) => ({ parameter, match: { type: 'contains', value: 'x' } });
const rule = (parameters: string[], extra: Record<string, unknown> = {}) => ({
  id: 'r1',
  rule_v2: parameters.map((parameter) => ({ parameter, match: { type: 'contains', value: 'x' } })),
  ...extra,
});

describe('a rule permits what it names', () => {
  it('reads every member of a parameter list', () => {
    // A condition may name one parameter or a list of them, and the engine reads each. A plan blind to
    // the list form would be empty for a rule that reads a dozen fields.
    const list = {
      id: 'r1',
      rule_v2: [{ parameter: ['post.q', 'raw', 'cookie.session'], match: { type: 'contains', value: 'x' } }],
    };

    expect(derivePlan(list).named, 'the named members, and not the whole-request one').toEqual([
      'cookie.session',
      'post.q',
    ]);
  });

  it.each([
    'get.redirect_to',
    'post.title',
    'cookie.session',
    'server.HTTP_AUTHORIZATION',
    'files.avatar',
    'egress.url',
    'request.q',
  ])('permits the value of %s, because the rule was written to inspect it', (parameter) => {
    expect(derivePlan(rule([parameter])).named).toEqual([parameter]);
  });

  it('takes the union across conditions and nested groups', async () => {
    // The engine reports which RULE matched, not which condition, so a plan narrower than the rule would
    // claim a precision the detection does not have.
    const nested = {
      id: 'r1',
      rule_v2: [
        { parameter: 'post.title', match: { type: 'contains', value: 'x' } },
        {
          parameter: 'rules',
          rules: [
            { parameter: 'get.q', match: { type: 'contains', value: 'x' } },
            { parameter: 'cookie.session', match: { type: 'contains', value: 'x' } },
          ],
        },
      ],
    };

    expect(derivePlan(nested).named).toEqual(['cookie.session', 'get.q', 'post.title']);
  });

  it('names each parameter once, however often the rule reads it', () => {
    expect(derivePlan(rule(['post.title', 'post.title', 'post.title'])).named).toEqual(['post.title']);
  });
});

describe('a rule that reads everything permits nothing', () => {
  it.each(['raw', 'all'])('derives no permission from %s', (parameter) => {
    // These read the whole request. Deriving a permission from them would mean the broadest rules
    // granting the broadest capture, which is exactly backwards.
    const plan = derivePlan(rule([parameter]));

    expect(plan.named).toEqual([]);
    expect(plan.prefixes).toEqual([]);
    expect(permitsAnything(plan)).toBe(false);
  });

  it('derives nothing from a bare source wildcard', () => {
    // `post.*` names nothing in particular: it is `all` wearing a different hat.
    expect(permitsAnything(derivePlan(rule(['post.*'])))).toBe(false);
  });

  it('still permits the parameters a broad rule ALSO names', () => {
    // `raw` adds nothing, but it does not poison what the rule names beside it.
    expect(derivePlan(rule(['raw', 'post.title'])).named).toEqual(['post.title']);
  });
});

describe('a prefix permits matching keys and no others', () => {
  it('records the prefix rather than the pattern', () => {
    expect(derivePlan(rule(['post.field_*'])).prefixes).toEqual(['post.field_']);
  });

  it('bounds how many keys a prefix may match', () => {
    // A prefix can match an unbounded number of keys, and "a rule that reads a prefix" must not become
    // "a rule that reads the whole body".
    expect(derivePlan(rule(['post.field_*'])).limits.prefixKeys).toBe(CAPTURE_LIMITS.prefixKeys);
    expect(CAPTURE_LIMITS.prefixKeys).toBeLessThan(CAPTURE_LIMITS.values + 1);
  });
});

describe('the contract decides what is a parameter at all', () => {
  it.each([
    // `server` and `egress` enumerate their keys and do not fan out, so these are not parameters the
    // engine can read — and a permission for something no rule can read is a permission with no rule
    // behind it.
    'server.HTTP_*',
    'server.not-real',
    'egress.not-real',
    'egress.*',
    'response.header.*',
  ])('derives nothing from %s, which no rule may read', (parameter) => {
    expect(permitsAnything(derivePlan(rule([parameter])))).toBe(false);
  });

  it.each([
    'server.HTTP_AUTHORIZATION',
    'server.REQUEST_URI',
    'egress.url',
    'files.avatar.filename',
    // `files` keys are application field names, so the contract accepts any of them — including one
    // whose suffix it does not enumerate.
    'files.avatar.invented',
  ])(
    'still permits %s, which a rule may read',
    (parameter) => {
      expect(derivePlan(rule([parameter])).named).toEqual([parameter]);
    },
  );
});

describe('the response phase is never a capture source', () => {
  it.each(['response.body', 'response.headers', 'response.status'])('refuses %s', (parameter) => {
    // Those read what the application is about to SEND. The phase inspecting them exists to redact
    // secrets, so capturing them would collect the values that redaction is there to stop leaving.
    expect(permitsAnything(derivePlan(rule([parameter])))).toBe(false);
  });
});

describe('raw bytes need an explicit opt-in, and are bounded anyway', () => {
  it('permits nothing without one', () => {
    expect(derivePlan(rule(['post.title'])).raw).toBeNull();
  });

  it('permits a bounded prefix when a rule carries one', () => {
    expect(derivePlan(rule(['raw'], { capture: { version: 1, raw_chars: 128 } })).raw).toEqual({ chars: 128 });
  });

  it('gives a rule the cap rather than what it asked for', () => {
    // The opt-in says a reviewer agreed raw bytes are needed here, not that this rule sets its own
    // bounds.
    expect(derivePlan(rule(['raw'], { capture: { version: 1, raw_chars: 10_000 } })).raw).toEqual({
      chars: CAPTURE_LIMITS.valueChars,
    });
  });

  it.each([
    ['a negative request', -1],
    ['zero', 0],
    ['a fraction', 12.5],
    // Coercion is not consent: none of these is a number a reviewer wrote.
    ['a string of digits', '128'],
    ['true', true],
    ['a one-element array', [128]],
    ['text', 'lots'],
    ['nothing', undefined],
  ])('refuses %s', (_what, raw_chars) => {
    expect(derivePlan(rule(['raw'], { capture: { version: 1, raw_chars } })).raw).toBeNull();
  });

  it.each([
    ['no version at all', { raw_chars: 128 }],
    // An opt-in that authorises nothing is a property with no reason to exist, and a consumer cannot tell
    // it from one that was meant to say something and does not.
    ['nothing it is opting into', { version: 1 }],
    ['a version this guard does not know', { version: 2, raw_chars: 128 }],
    ['a version that is not a number', { version: '1', raw_chars: 128 }],
    ['a key the contract does not define', { version: 1, raw_chars: 128, everything: true }],
    ['a list instead of an object', [{ version: 1, raw_chars: 128 }]],
    ['a string', 'raw'],
  ])('refuses an opt-in with %s', (_what, capture) => {
    // The opt-in authorises collection, so a guard meeting one it cannot read must grant nothing rather
    // than guess. That is also what lets a newer server extend it without an older guard capturing under
    // rules it does not understand.
    expect(derivePlan(rule(['raw'], { capture })).raw).toBeNull();
  });

  it('refuses an opt-in the rule does not own', () => {
    // One write to a prototype would otherwise grant raw capture to every rule at once.
    (Object.prototype as any).capture = { version: 1, raw_chars: 512 };
    try {
      const r = rule(['post.title']);

      expect((r as any).capture, 'the chain does offer one').toBeTruthy();
      expect(derivePlan(r).raw, 'but it belongs to no rule').toBeNull();
    } finally {
      delete (Object.prototype as any).capture;
    }
  });
});

describe('a parameter list is one level deep', () => {
  const nested = {
    id: 'r1',
    rule_v2: [{ parameter: [['post.q']], match: { type: 'contains', value: 'x' } }],
  };

  it('is refused by the validator rather than accepted and inert', () => {
    // The engine expands one level: a member that is itself a list resolves to nothing. Accepting this
    // would pass a rule that names a parameter and matches on none — protection that reads as present.
    const { bundle, rejected } = validateBundle({ firewall: [nested], whitelists: [], whitelist_keys: {} });

    expect(bundle.firewall).toEqual([]);
    expect(rejected[0].reason).toMatch(/parameters, not more lists/);
  });

  it('grants no permission for a parameter buried inside one', () => {
    expect(permitsAnything(derivePlan(nested as never))).toBe(false);
  });

  it('still reads a flat list, which is what the engine expands', () => {
    const flat = {
      id: 'r1',
      rule_v2: [{ parameter: ['post.q', 'cookie.session'], match: { type: 'contains', value: 'x' } }],
    };

    expect(derivePlan(flat as never).named).toEqual(['cookie.session', 'post.q']);
  });
});

describe('a rule that cannot produce a detection permits nothing', () => {
  it('grants no raw capture to a rule with no conditions', () => {
    // A permission exists to explain a detection. The opt-in is a property ON a rule, not a licence of
    // its own, so a rule the engine cannot read authorises nothing however the opt-in is written.
    const plan = derivePlan({ id: 'r1', capture: { version: 1, raw_chars: 128 } } as never);

    expect(plan.raw).toBeNull();
    expect(permitsAnything(plan)).toBe(false);
  });

  it.each([
    ['conditions that are not a list', { id: 'r1', rule_v2: 'nonsense' }],
    ['an empty condition list', { id: 'r1', rule_v2: [] }],
    ['only parameters no rule may read', { id: 'r1', rule_v2: [{ parameter: 'server.HTTP_*' }] }],
    // Spelled correctly and still not a rule: the guard refuses it, so it produces no detection to
    // explain. A permission derived from spelling alone would outlive the rule that justified it.
    ['a parameter and no match', { id: 'r1', rule_v2: [{ parameter: 'post.q' }] }],
    [
      'a match the engine does not have',
      { id: 'r1', rule_v2: [{ parameter: 'post.q', match: { type: 'invented', value: 'x' } }] },
    ],
    ['a phase that does not exist', { id: 'r1', rule_v2: [leafFor('post.q')], phase: 'sideways' }],
  ])('grants nothing to a rule with %s', (_what, shape) => {
    const plan = derivePlan({ ...shape, capture: { version: 1, raw_chars: 128 } } as never);

    expect(plan.raw, 'no raw permission').toBeNull();
    expect(permitsAnything(plan), 'and no named permission either').toBe(false);
  });

  it('grants capture to a rule that matches on the whole request and names no parameter', () => {
    // The positive control the validator gate needs. `cross_origin` and its kin read the whole request
    // and carry no parameter, so a gate asking for a parameter would deny a perfectly good rule the
    // evidence it was opted into.
    const wholeRequest = {
      id: 'csrf',
      rule_v2: [{ match: { type: 'cross_origin', value: '' } }],
      capture: { version: 1, raw_chars: 128 },
    };

    expect(derivePlan(wholeRequest as never).raw, 'it can fire, so it can explain itself').toEqual({
      chars: 128,
    });
  });

  it('still grants it to a rule that reads the raw body', () => {
    // The positive control, and the opt-in's actual purpose: a rule matching on `raw` may capture a
    // bounded prefix of it.
    expect(derivePlan(rule(['raw'], { capture: { version: 1, raw_chars: 128 } })).raw).toEqual({
      chars: 128,
    });
  });
});

describe('an unreadable rule permits nothing', () => {
  it.each([
    ['no rule at all', undefined],
    ['null', null],
    ['a rule with no conditions', { id: 'r1' }],
    ['conditions that are not a list', { id: 'r1', rule_v2: 'nonsense' }],
    ['conditions that are not objects', { id: 'r1', rule_v2: [null, 3, 'x'] }],
    ['a parameter that is not a string', { id: 'r1', rule_v2: [{ parameter: 7 }] }],
    ['a source nobody defines', { id: 'r1', rule_v2: [{ parameter: 'invented.thing' }] }],
    // `all` and `raw` are whole-request reads, not sources with keys. Nothing resolves these, so a plan
    // that granted them would be granting capture for a parameter the rule cannot even read.
    ['a key hung off all', { id: 'r1', rule_v2: [{ parameter: 'all.x' }] }],
    ['a key hung off raw', { id: 'r1', rule_v2: [{ parameter: 'raw.x' }] }],
    ['a source with no key', { id: 'r1', rule_v2: [{ parameter: 'post.' }] }],
  ])('permits nothing for %s', (_what, input) => {
    // Failing to understand a rule must never be the reason something gets captured.
    const plan = derivePlan(input as never);

    expect(permitsAnything(plan)).toBe(false);
    expect(plan.named).toEqual([]);
  });

  it('does not recurse without bound on a self-referencing group', () => {
    const loop: any = { id: 'r1', rule_v2: [{ parameter: 'rules', rules: [] }] };
    loop.rule_v2[0].rules.push(loop.rule_v2[0]);

    expect(() => derivePlan(loop)).not.toThrow();
  });
});

describe('a plan reference names the policy, not the moment', () => {
  it('is the same for the same permissions', () => {
    // Two events carrying one reference were governed by the same permissions, across processes and
    // releases — otherwise a reader cannot tell what a capture was allowed to include.
    expect(planReference(derivePlan(rule(['post.title', 'get.q'])))).toBe(
      planReference(derivePlan(rule(['get.q', 'post.title']))),
    );
  });

  it('does not depend on the order the permissions are listed in', () => {
    // `derivePlan` sorts, so this cannot arise from it today — but the reference is what ties a captured
    // value to the policy that allowed it, and that tie must not rest on an ordering somewhere else.
    const limits = { values: 10, valueChars: 512, prefixKeys: 5 };
    const one = { named: ['get.q', 'post.title'], prefixes: ['post.a.', 'post.b.'], raw: null, limits };
    const other = { named: ['post.title', 'get.q'], prefixes: ['post.b.', 'post.a.'], raw: null, limits };

    expect(planReference(other)).toBe(planReference(one));
  });

  it('covers the limits, not only the parameters', () => {
    // Two plans naming the same parameters but allowing 512 and 4096 characters are different
    // permissions. A reference that could not tell them apart would fail at exactly the claim it exists
    // to support.
    const base = derivePlan(rule(['post.title']));
    const looser = { ...base, limits: { ...base.limits, valueChars: 4096 } };
    const fewer = { ...base, limits: { ...base.limits, values: 1 } };

    expect(planReference(looser)).not.toBe(planReference(base));
    expect(planReference(fewer)).not.toBe(planReference(base));
  });

  it('is exactly this, for this literal plan', () => {
    // A pinned vector for the ALGORITHM, over a plan written out here rather than derived. Every
    // reference already emitted means whatever this algorithm and canonical form produced, so replacing
    // either silently would change what all of them refer to while every relative assertion above still
    // passed. Changing them deliberately takes a new prefix, not a new implementation under the old one.
    //
    // The limits are literal too. A future policy change to `CAPTURE_LIMITS` should give a different
    // reference under the SAME algorithm, and a vector reading the current limits would call that a
    // reason to change the prefix.
    const plan = {
      named: ['get.q', 'post.title'],
      prefixes: [],
      raw: null,
      limits: { values: 10, valueChars: 512, prefixKeys: 5 },
    };

    expect(planReference(plan)).toBe('cp1-bf0f418cf2f24752c827a4f8e3b6334a');
  });

  it('changes when a limit changes, without changing the algorithm', () => {
    // The policy moving is not the algorithm moving: the reference follows the permissions, the prefix
    // stays put.
    const base = { named: ['post.title'], prefixes: [], raw: null, limits: { values: 10, valueChars: 512 } };
    const tighter = { ...base, limits: { values: 10, valueChars: 128 } };

    expect(planReference(tighter)).not.toBe(planReference(base));
    expect(planReference(tighter).startsWith('cp1-')).toBe(true);
  });

  it('is what derivePlan produces under the limits in force', () => {
    // Kept apart from the vector above: this one is allowed to change when the policy does.
    const plan = derivePlan(rule(['post.title', 'get.q']));

    expect(plan.named).toEqual(['get.q', 'post.title']);
    expect(plan.limits).toEqual(CAPTURE_LIMITS);
  });

  it('is wide enough to be a durable identity', () => {
    // It outlives the process and is compared across systems, so two different plans meeting on one
    // reference must not be something a reader has to think about.
    const reference = planReference(derivePlan(rule(['post.title'])));

    expect(reference).toMatch(/^cp1-[0-9a-f]{32}$/);
  });

  it('differs when the permissions differ', () => {
    const reads = planReference(derivePlan(rule(['post.title'])));

    expect(planReference(derivePlan(rule(['post.body'])))).not.toBe(reads);
    expect(planReference(derivePlan(rule(['post.title', 'get.q'])))).not.toBe(reads);
    expect(planReference(derivePlan(rule(['post.title'], { capture: { version: 1, raw_chars: 64 } })))).not.toBe(reads);
  });
});

describe('a plan cannot change after its reference is computed', () => {
  it('is frozen, along with everything it holds', () => {
    // The reference identifies a set of permissions. A plan that could be edited afterwards would leave
    // the reference naming permissions that no longer apply.
    const plan = derivePlan(rule(['post.title'], { capture: { version: 1, raw_chars: 64 } }));

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.named)).toBe(true);
    expect(Object.isFrozen(plan.prefixes)).toBe(true);
    expect(Object.isFrozen(plan.raw)).toBe(true);
    expect(Object.isFrozen(plan.limits)).toBe(true);
    expect(Object.isFrozen(CAPTURE_LIMITS)).toBe(true);
  });
});

describe('plans are derived once per rule', () => {
  it('reuses the plan for a rule it has seen', () => {
    const cache = createPlanCache();
    const r = { ...rule(['post.title']), source_revision: 'rev-1' };

    expect(cache.for(r).plan).toBe(cache.for(r).plan);
    expect(cache.derivations, 'derived once, answered twice').toBe(1);
  });

  it('does not answer for one rule with another rule\'s permissions', () => {
    // A revision identifies a version of ONE rule, not a rule. Two rules can carry the same revision, and
    // a cache keyed on that alone would capture a field the second rule never authorised.
    const cache = createPlanCache();
    const first = { ...rule(['post.title']), id: 'rule-a', source_revision: 'shared-rev' };
    const second = { ...rule(['cookie.session']), id: 'rule-b', source_revision: 'shared-rev' };

    expect(cache.for(first).plan.named).toEqual(['post.title']);
    expect(cache.for(second).plan.named, 'its own permissions, not the first rule\'s').toEqual([
      'cookie.session',
    ]);
  });

  it('derives again for a rule that arrived as a new object', () => {
    // A refreshed bundle brings new rule objects, so a changed rule is derived again rather than answered
    // from an entry describing what it used to say.
    const cache = createPlanCache();
    cache.for({ ...rule(['post.title']), source_revision: 'rev-1' });
    const updated = cache.for({ ...rule(['post.title', 'cookie.session']), source_revision: 'rev-2' });

    expect(updated.plan.named).toEqual(['cookie.session', 'post.title']);
    expect(cache.derivations).toBe(2);
  });

  it('answers for a rule that is not an object at all', () => {
    const cache = createPlanCache();

    expect(permitsAnything(cache.for(undefined as never).plan)).toBe(false);
    expect(cache.for(null as never).reference).toMatch(/^cp1-/);
  });

  it('hands out an entry that cannot be edited', () => {
    const cache = createPlanCache();
    const entry = cache.for({ ...rule(['post.title']), source_revision: 'rev-1' });

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.plan)).toBe(true);
  });
});

describe('capture metadata never costs the mitigation', () => {
  const leaf = { parameter: 'get.q', match: { type: 'contains', value: 'x' } };
  const served = (capture: unknown) => ({
    firewall: [{ id: 'r1', title: 'a rule that still has to protect', rule_v2: [leaf], capture }],
    whitelists: [],
    whitelist_keys: {},
  });

  it.each([
    ['a version this guard does not know', { version: 2, raw_chars: 128 }],
    ['a version that is not a number', { version: '1', raw_chars: 128 }],
    ['a key the contract does not define', { version: 1, raw_chars: 128, everything: true }],
    ['a malformed size', { version: 1, raw_chars: -5 }],
    ['nothing at all', null],
    ['a string', 'raw'],
  ])('keeps a rule carrying %s, and grants it no capture', (_what, capture) => {
    // A rule is a mitigation. Letting a capture value the guard cannot read decide whether the rule runs
    // would turn a question about evidence into the loss of the protection — a newer server adding a
    // capture version would switch off shielding on every older guard.
    const { bundle, rejected } = validateBundle(served(capture));

    expect(rejected, 'the rule was not dropped').toEqual([]);
    expect(bundle.firewall.length, 'the rule still protects').toBe(1);
    expect(derivePlan(bundle.firewall[0]).raw, 'and collects nothing').toBeNull();
  });

  it('grants capture for the opt-in it does understand', () => {
    // The positive control: the separation is only meaningful if a valid opt-in still works.
    const { bundle, rejected } = validateBundle(served({ version: 1, raw_chars: 128 }));

    expect(rejected).toEqual([]);
    expect(bundle.firewall.length).toBe(1);
    expect(derivePlan(bundle.firewall[0]).raw).toEqual({ chars: 128 });
  });
});

describe('the published contract and the runtime give the same answer', () => {
  const published = ruleContract().capture;

  it('does not publish a maximum a consumer would refuse a working rule over', () => {
    // A schema maximum would have a consumer reject what this guard accepts and runs. Asking for more
    // than the ceiling is a request, not an authoring error, so the ceiling is published beside the
    // schema rather than inside it.
    expect(published.properties.raw_chars.maximum, 'no schema maximum').toBeUndefined();
    expect(published.raw_chars_effective_maximum).toBe(CAPTURE_LIMITS.valueChars);
  });

  it('accepts a request above the ceiling and answers with the ceiling', () => {
    const asked = published.raw_chars_effective_maximum * 20;
    const served = {
      firewall: [{ id: 'r1', rule_v2: [leafFor('raw')], capture: { version: 1, raw_chars: asked } }],
      whitelists: [],
      whitelist_keys: {},
    };
    const { bundle, rejected } = validateBundle(served);

    expect(rejected, 'the contract does not refuse it').toEqual([]);
    expect(derivePlan(bundle.firewall[0]).raw, 'and the runtime answers with the ceiling').toEqual({
      chars: published.raw_chars_effective_maximum,
    });
  });

  it('refuses everything the published schema refuses', () => {
    // The schema is what a consumer implements against, so the two must agree on rejection too.
    expect(published.required).toEqual(['version', 'raw_chars']);
    expect(published.additional_properties).toBe(false);
    expect(published.properties.version.const).toBe(1);
    expect(published.properties.raw_chars.minimum).toBe(1);

    expect(captureProblem({ raw_chars: 8 }), 'version is required').not.toBeNull();
    expect(captureProblem({ version: 1 }), 'raw_chars is required').not.toBeNull();
    expect(captureProblem({ version: 2, raw_chars: 8 }), 'version must be the one published').not.toBeNull();
    expect(captureProblem({ version: 1, raw_chars: 0 }), 'below the minimum').not.toBeNull();
    expect(captureProblem({ version: 1, raw_chars: 8, extra: 1 }), 'no other keys').not.toBeNull();
    expect(captureProblem({ version: 1, raw_chars: 8 }), 'and this one is valid').toBeNull();
  });
});
