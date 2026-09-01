import { describe, it, expect } from 'vitest';
import {
  CAPTURE_LIMITS,
  createPlanCache,
  derivePlan,
  permitsAnything,
  planReference,
} from '../../src/protect/capture-plan.js';

/**
 * What a rule permits to be captured, and — mostly — what it does not.
 *
 * The interesting direction is refusal. A rule earns each permission by naming what it reads, so the
 * cases that matter are the ones where a rule reads broadly and must therefore permit nothing: those are
 * where a capture policy quietly turns a security channel into a copy of an application's traffic.
 */
const rule = (parameters: string[], extra: Record<string, unknown> = {}) => ({
  id: 'r1',
  rule_v2: parameters.map((parameter) => ({ parameter, match: { type: 'contains', value: 'x' } })),
  ...extra,
});

describe('a rule permits what it names', () => {
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
    expect(derivePlan(rule(['raw'], { capture: { raw_chars: 128 } })).raw).toEqual({ chars: 128 });
  });

  it('gives a rule the cap rather than what it asked for', () => {
    // The opt-in says a reviewer agreed raw bytes are needed here, not that this rule sets its own
    // bounds.
    expect(derivePlan(rule(['raw'], { capture: { raw_chars: 10_000 } })).raw).toEqual({
      chars: CAPTURE_LIMITS.valueChars,
    });
  });

  it.each([
    ['a negative request', -1],
    ['zero', 0],
    ['text', 'lots'],
    ['nothing', undefined],
  ])('refuses %s', (_what, raw_chars) => {
    expect(derivePlan(rule(['raw'], { capture: { raw_chars } })).raw).toBeNull();
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

  it('differs when the permissions differ', () => {
    const reads = planReference(derivePlan(rule(['post.title'])));

    expect(planReference(derivePlan(rule(['post.body'])))).not.toBe(reads);
    expect(planReference(derivePlan(rule(['post.title', 'get.q'])))).not.toBe(reads);
    expect(planReference(derivePlan(rule(['post.title'], { capture: { raw_chars: 64 } })))).not.toBe(reads);
  });
});

describe('plans are derived once per revision', () => {
  it('reuses the plan for a revision it has seen', () => {
    const cache = createPlanCache();
    const r = { ...rule(['post.title']), rule_revision: 'rev-1' };

    expect(cache.for(r).plan).toBe(cache.for(r).plan);
    expect(cache.size).toBe(1);
  });

  it('derives again when the revision changes', () => {
    // A rule that changes gets a new revision, so a captured value can always be traced to the policy
    // that permitted it rather than to whatever the rule says by the time someone looks.
    const cache = createPlanCache();
    const first = cache.for({ ...rule(['post.title']), rule_revision: 'rev-1' });
    const second = cache.for({ ...rule(['post.title', 'cookie.session']), rule_revision: 'rev-2' });

    expect(second.plan).not.toBe(first.plan);
    expect(second.reference).not.toBe(first.reference);
    expect(cache.size).toBe(2);
  });

  it('does not cache a rule the bundle gave no revision', () => {
    // Nothing identifies it, so a cache entry would answer for a rule that had since changed.
    const cache = createPlanCache();
    cache.for(rule(['post.title']));

    expect(cache.size).toBe(0);
  });
});
