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
    expect(rejected).toHaveLength(3);
    expect(rejected[0].reason).toMatch(/maxRules/);
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
