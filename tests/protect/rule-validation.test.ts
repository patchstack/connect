import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateBundle, LIMITS } from '../../src/protect/rules/validate.js';
import { normalizeBundle } from '../../src/protect/rules/source.js';
import { resolveApiBase } from '../../src/protect/firewall-log.js';
import { _testExports } from '../../src/protect/engine/engine.js';

// Delivered rules are policy fetched over the network and executed on every request, so the bundle is
// validated before the engine sees it: bounded size/nesting/pattern length, known phases + actions, and
// a rejected rule is REPORTED (never silently "loaded" while protecting nothing).

const ok = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '__proto__' } }],
  ...over,
});

describe('validateBundle', () => {
  it('keeps a well-formed rule untouched', () => {
    const { bundle, rejected } = validateBundle({ firewall: [ok()], whitelists: [] });
    expect(rejected).toEqual([]);
    expect(bundle.firewall).toHaveLength(1);
  });

  it.each([
    ['unknown phase', ok({ phase: 'sideways' }), /unknown phase/],
    ['unknown action', ok({ action: 'destroy' }), /unknown action/],
    ['empty rule_v2', ok({ rule_v2: [] }), /empty/],
    ['non-array rule_v2', ok({ rule_v2: 'nope' }), /must be an array/],
    ['condition without match', ok({ rule_v2: [{ parameter: 'raw' }] }), /no match object/],
    ['bad max_bytes', ok({ max_bytes: -1 }), /max_bytes/],
  ])('rejects %s with a reason', (_label, rule, reason) => {
    const { bundle, rejected } = validateBundle({ firewall: [rule as any], whitelists: [] });
    expect(bundle.firewall).toHaveLength(0);
    expect(rejected[0].reason).toMatch(reason);
    expect(rejected[0].id).toBe('r1');
  });

  it('rejects an over-long regex and deep nesting', () => {
    const longRe = ok({ rule_v2: [{ parameter: 'raw', match: { type: 'regex', value: '/' + 'a'.repeat(LIMITS.maxRegexLength + 5) + '/' } }] });
    expect(validateBundle({ firewall: [longRe], whitelists: [] }).rejected[0].reason).toMatch(/regex longer/);

    let nested: any = { parameter: 'raw', match: { type: 'contains', value: 'x' } };
    for (let i = 0; i < LIMITS.maxNestingDepth + 3; i++) nested = { parameter: 'rules', rules: [nested] };
    expect(validateBundle({ firewall: [ok({ rule_v2: [nested] })], whitelists: [] }).rejected[0].reason).toMatch(/nesting deeper/);
  });

  it('caps the number of rules rather than accepting an unbounded bundle', () => {
    const many = Array.from({ length: LIMITS.maxRules + 3 }, (_, i) => ok({ id: `r${i}` }));
    const { bundle, rejected } = validateBundle({ firewall: many, whitelists: [] });
    expect(bundle.firewall).toHaveLength(LIMITS.maxRules);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/maxRules/);
  });

  it('bounds rejection details and common list-shaped operands', () => {
    const invalid = Array.from({ length: 500 }, (_, i) => ok({ id: `bad-${i}`, phase: 'sideways' }));
    const rejected = validateBundle({ firewall: invalid, whitelists: [] }).rejected;
    expect(rejected.length).toBeLessThanOrEqual(101);
    expect(rejected.at(-1)?.reason).toMatch(/additional rejected entries omitted/);

    const parameters = Array.from({ length: LIMITS.maxParameterItems + 1 }, (_, i) => `post.field${i}`);
    expect(validateBundle({ firewall: [ok({ rule_v2: [{ parameter: parameters, match: { type: 'contains', value: 'x' } }] })], whitelists: [] }).rejected[0].reason)
      .toMatch(/parameter list/);

    const values = Array.from({ length: LIMITS.maxOperandItems + 1 }, (_, i) => `value-${i}`);
    expect(validateBundle({ firewall: [ok({ rule_v2: [{ parameter: 'post.field', match: { type: 'in_array', value: values } }] })], whitelists: [] }).rejected[0].reason)
      .toMatch(/more than/);
  });

  it('bounds optional match operands and whitelist key maps', () => {
    const longOptionalOperand = validateBundle({
      firewall: [ok({ rule_v2: [{ parameter: 'post.file', match: { type: 'isset', value: 'x'.repeat(LIMITS.maxValueLength + 1) } }] })],
      whitelists: [],
    });
    expect(longOptionalOperand.rejected[0].reason).toMatch(/operand "value" is longer/);

    const whitelistKeys = Object.fromEntries(
      Array.from({ length: LIMITS.maxMapEntries + 1 }, (_, index) => [`key-${index}`, ['value']]),
    );
    const oversizedMap = validateBundle({ firewall: [], whitelists: [], whitelist_keys: whitelistKeys });
    expect(oversizedMap.rejected[0].reason).toMatch(/whitelist_keys has more/);
    expect(oversizedMap.bundle.whitelist_keys).toEqual({});
  });

  it('caps total condition nodes even when every nested array is individually small', () => {
    const leaves = Array.from(
      { length: LIMITS.maxConditionsPerRule },
      () => ({ parameter: 'raw', match: { type: 'contains', value: 'x' } }),
    );
    const groups = Array.from(
      { length: Math.ceil((LIMITS.maxConditionNodesPerRule + 1) / (leaves.length + 1)) },
      () => ({ parameter: 'rules', rules: leaves }),
    );
    const result = validateBundle({ firewall: [ok({ rule_v2: groups })], whitelists: [] });
    expect(result.bundle.firewall).toHaveLength(0);
    expect(result.rejected[0].reason).toMatch(/total condition nodes/);
  });

  it('caps condition nodes across the complete bundle', () => {
    const leaves = Array.from(
      { length: 249 },
      () => ({ parameter: 'raw', match: { type: 'contains', value: 'x' } }),
    );
    const conditions = Array.from({ length: 4 }, () => ({ parameter: 'rules', rules: leaves }));
    const count = Math.floor(LIMITS.maxConditionNodesPerBundle / 1000) + 1;
    const result = validateBundle({
      firewall: Array.from({ length: count }, (_, id) => ok({ id: `r${id}`, rule_v2: conditions })),
      whitelists: [],
    });
    expect(result.bundle.firewall).toHaveLength(count - 1);
    expect(result.rejected.at(-1)?.reason).toMatch(/bundle exceeds.*condition nodes/);
  });

  it('validates whitelists too (a malformed one would suppress real rules)', () => {
    const { bundle, rejected } = validateBundle({ firewall: [], whitelists: [{ rule_id: 'r1', rule_v2: [] } as any] });
    expect(bundle.whitelists).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/whitelist/);
  });
});

describe('normalizeBundle reports rejections', () => {
  it('drops invalid rules and reports each one', () => {
    const seen: any[] = [];
    const out = normalizeBundle(
      { firewall: [ok(), ok({ id: 'bad', phase: 'nope' })], whitelists: [] } as any,
      { onRuleRejected: (r: any) => seen.push(r) },
    );
    expect(out.firewall.map((r: any) => r.id)).toEqual(['r1']);
    expect(seen).toEqual([expect.objectContaining({ id: 'bad', reason: expect.stringMatching(/unknown phase/) })]);
  });
});

describe('regex pattern length backstop', () => {
  it('refuses to compile an absurdly long pattern', () => {
    const { safeRegExp } = _testExports as any;
    expect(safeRegExp('/' + 'a'.repeat(2000) + '/')).toBeNull();
    expect(safeRegExp('/AKIA[0-9A-Z]{16}/')).not.toBeNull();
  });

  it('refuses adjacent unbounded atoms before a delivered rule reaches evaluation', () => {
    const { safeRegExp } = _testExports as any;
    expect(safeRegExp('/a+b+c/')).toBeNull();
    expect(safeRegExp('/prefix-a+b+c/')).toBeNull();
    expect(safeRegExp('/[a:]+:[a]+/')).toBeNull();
    expect(safeRegExp('/[a]+:[a]+/')).not.toBeNull();
    expect(safeRegExp('/postgres:\\/\\/[A-Za-z0-9:._-]+:[A-Za-z0-9:._-]+@/i')).toBeNull();
    expect(safeRegExp('/postgres:\\/\\/[A-Za-z0-9._-]+:[A-Za-z0-9:._-]+@/i')).not.toBeNull();
    expect(safeRegExp('/a+(?:a?)a+/')).toBeNull();
    expect(safeRegExp('/a+(?=a)a+/')).toBeNull();
    const result = validateBundle({
      firewall: [ok({ rule_v2: [{ parameter: 'raw', match: { type: 'regex', value: '/a+b+c/' } }] })],
      whitelists: [],
    });
    expect(result.bundle.firewall).toHaveLength(0);
    expect(result.rejected[0].reason).toMatch(/unsafe repetition/);
  });
});

describe('telemetry API origin', () => {
  const prev = process.env.PATCHSTACK_API_BASE;
  afterEach(() => {
    if (prev === undefined) delete process.env.PATCHSTACK_API_BASE;
    else process.env.PATCHSTACK_API_BASE = prev;
    vi.restoreAllMocks();
  });

  it('accepts an https override', () => {
    process.env.PATCHSTACK_API_BASE = 'https://api.example.com';
    expect(resolveApiBase(undefined)).toBe('https://api.example.com');
  });

  it('accepts localhost http for local testing', () => {
    process.env.PATCHSTACK_API_BASE = 'http://localhost:8080';
    expect(resolveApiBase(undefined)).toBe('http://localhost:8080');
  });

  it('refuses a plaintext remote origin (api-key exfiltration path) and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PATCHSTACK_API_BASE = 'http://evil.example.com';
    expect(resolveApiBase(undefined)).not.toBe('http://evil.example.com');
    expect(warn).toHaveBeenCalled();
  });
});

describe('rule endpoint origin', () => {
  // Rules are POLICY the engine executes on every request, so an attacker-controlled endpoint could
  // remove protection wholesale (empty bundle) or serve an expensive ruleset — a stronger threat than
  // the telemetry key. A non-default override must be https (localhost allowed for dev/tests).
  it('refuses a plaintext remote rule endpoint and falls back to the default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: any) => {
      seen.push(String(u));
      return new Response(JSON.stringify({ firewall: [], whitelists: [], whitelist_keys: {} }), { status: 200 });
    }));
    const { PulseRuleClient } = await import('../../src/protect/engine/pulse-client.js');
    await new PulseRuleClient({ siteUuid: 's1', baseUrl: 'http://evil.example.com/pulse' }).getRules();
    expect(seen[0]).toContain('https://api.patchstack.com'); // default, not the injected origin
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('still accepts https and localhost rule endpoints', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: any) => {
      seen.push(String(u));
      return new Response(JSON.stringify({ firewall: [], whitelists: [], whitelist_keys: {} }), { status: 200 });
    }));
    const { PulseRuleClient } = await import('../../src/protect/engine/pulse-client.js');
    await new PulseRuleClient({ siteUuid: 's1', baseUrl: 'https://x.test/monitor/pulse' }).getRules();
    await new PulseRuleClient({ siteUuid: 's2', baseUrl: 'http://127.0.0.1:8080' }).getRules();
    expect(seen[0]).toContain('https://x.test');
    expect(seen[1]).toContain('http://127.0.0.1:8080');
    vi.restoreAllMocks();
  });
});

describe('repetition shapes that backtrack exponentially', () => {
  const { safeRegExp } = _testExports;

  // Each of these re-splits a run that does not match in more ways than any request can wait for. The
  // outer bound does not have to be `+` or `*`, and a lookaround is a pattern of its own.
  it.each([
    ['a bounded repeat of an unbounded run', '/(a+){2,40}$/'],
    ['a fixed repeat of a run with a wildcard', '/(.*a){12}$/'],
    ['an open-ended repeat of a run', '/(?:x+y?){3,}/'],
    ['a bounded repeat of a bounded run, when the product is large', '/(a{1,30}){1,30}$/'],
    ['a large bounded repeat of an alternation', '/(a|a){1,40}$/'],
    ['adjacent wildcards inside a lookahead', '/^(?=.*.*.*.*x)/'],
    ['adjacent wildcards inside a lookbehind', '/(?<=.*.*.*x)y/'],
    ['a fence the repeated class can also match', '/(?:\\.[a-z.]+){0,8}$/'],
    ['an optional fence', '/(?:\\.?[a-z]+){0,8}!/'],
    ['two optional elements repeated many times', '/(?:a?a?){30}$/'],
    ['optional elements repeated without a bound', '/(?:a?b?)+$/'],
    ['a single optional element repeated many times', '/(a?){25}$/'],
    ['an optional element beside one that matches the same character', '/(?:a?a){30}!/'],
    ['an alternation with an empty branch repeated many times', '/(?:a|a?){20}!/'],
    ['a fence an optional element can also take', '/(?:y?y){20}$/'],
    ['a class fence an optional element overlaps', '/(?:\\w[a-z]?){20}$/'],
    ['a class fence under the unicode flag, where it cannot be proven', '/(?:\\d[ -]?){13,16}/u'],
  ])('refuses %s', (_label, pattern) => {
    expect(safeRegExp(pattern)).toBeNull();
  });

  it.each([
    ['a small bounded repeat of a small run', '/(\\d{1,3}\\.){3}\\d{1,3}/'],
    ['a repeat fenced by a character its run cannot match', '/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+){0,8}\\.[A-Za-z]{2,}/'],
    ['a bounded repeat of a fixed sequence', '/(?:ab){2,5}/'],
    ['a small bounded repeat of an alternation', '/(?:a|b){2}/'],
    ['a plain lookahead', '/^(?=.*x)abc/'],
    ['a unicode property run', '/\\p{L}{2,}/u'],
    ['a named group and its back-reference', '/(?<y>\\d{4})-\\k<y>/'],
    ['a literal brace', '/x{/'],
    ['a class fence nothing optional inside can take', '/(?:\\d[ -]?){13,16}/'],
    ['a fence at the end of each repetition', '/(?:x?y){0,40}$/'],
    ['an optional element after a literal fence', '/(?:\\.a?){40}$/'],
    ['an optional element repeated a few times', '/(?:a?b?){4}$/'],
  ])('accepts %s', (_label, pattern) => {
    expect(safeRegExp(pattern)).not.toBeNull();
  });

  it('hands out a fresh pattern each time, so a global one keeps no position between matches', () => {
    const first = safeRegExp('/a/g')!;
    first.test('a');
    const second = safeRegExp('/a/g')!;

    expect(second).not.toBe(first);
    expect(second.lastIndex).toBe(0);
  });
});
