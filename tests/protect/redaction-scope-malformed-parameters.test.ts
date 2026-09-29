import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * A response rule whose parameter list holds something other than a parameter name, given directly as a
 * response rule, is loaded, not rejected: the condition masks nothing, the rule is reported through
 * `onError`, and a response the rule matches follows the fallback for a match with nothing to mask. The
 * same rule delivered by the rules service is refused by the rule contract, so that update is rejected
 * whole and the previous rules stay in force. Neither path throws.
 */

afterEach(() => vi.restoreAllMocks());

const SAMPLE = 'SAMPLE-TOKEN-0123456789';
const PATTERN = { type: 'regex', value: '/SAMPLE-TOKEN-\\d+/' };
const EMPTY = { firewall: [], whitelists: [], whitelist_keys: {} };
const URL_OPT = 'https://x.test/monitor/pulse';

// `matches`: whether the engine can match the rule at all. A list whose readable member reads the header
// matches, and with nothing it can mask, withholds; one with no readable member never matches; and a
// member the engine cannot resolve fails the rule's evaluation, which the engine treats as no match.
const malformed: Array<[string, unknown[], boolean]> = [
  ['[null]', [null], false],
  ['[undefined]', [undefined], false],
  ['a header list with null', ['response.header.x-sample', null], true],
  ['a body list with null', ['response.body', null], true],
  ['a list with a number', ['response.header.x-sample', 42], false],
  ['a list with an object', ['response.header.x-sample', { name: 'response.body' }], false],
  ['a list with an empty string', ['response.header.x-sample', ''], true],
];

const SCOPE_REPORT = 'names no place in the response to mask';
const scopeReports = (errors: Error[]) => errors.filter((e) => e.message.includes(SCOPE_REPORT));

/** Withheld, or sent without anything masked beyond what is known: never widened. */
async function expectFallback(out: Response, matches: boolean) {
  expect(out.status).toBe(matches ? 500 : 200);
  if (!matches) {
    expect(out.headers.get('x-sample')).toBe(SAMPLE);
    expect(out.headers.get('x-other')).toBe(SAMPLE);
    expect(await out.text()).toBe(`{"note":"${SAMPLE}"}`);
  }
}

const badRule = (parameter: unknown) => ({
  id: 'malformed',
  phase: 'response',
  category: 'secret-exposure',
  action: 'redact',
  rule_v2: [{ parameter, match: PATTERN }],
});

const goodRule = {
  id: 'well-formed',
  phase: 'response',
  category: 'secret-exposure',
  action: 'redact',
  rule_v2: [{ parameter: 'response.header.x-good', match: PATTERN }],
};

const response = () =>
  new Response(`{"note":"${SAMPLE}"}`, {
    headers: { 'content-type': 'application/json', 'x-sample': SAMPLE, 'x-good': SAMPLE, 'x-other': SAMPLE },
  });

describe('a malformed parameter list on the first load', () => {
  it.each(malformed)('loads with %s, reports it, and follows the fallback', async (_label, parameter, matches) => {
    const errors: Error[] = [];
    const protection: any = await createProtection({
      rules: EMPTY,
      mode: 'block',
      onError: (error: Error) => errors.push(error),
      responseRules: [badRule(parameter)],
    });

    expect(scopeReports(errors)).toHaveLength(1);
    await expectFallback(await protection.screenResponse(response()), matches);
  });

  it('keeps a well-formed rule beside it working', async () => {
    const errors: Error[] = [];
    const protection: any = await createProtection({
      rules: EMPTY,
      mode: 'block',
      onError: (error: Error) => errors.push(error),
      responseRules: [badRule([null]), goodRule],
    });
    const out = await protection.screenResponse(response());

    expect(out.status).toBe(200);
    expect(out.headers.get('x-good')).toBe('[REDACTED]');
    expect(out.headers.get('x-other')).toBe(SAMPLE);
    expect(errors).toHaveLength(1);
  });

  it.each([
    ['a null condition', [null, { parameter: 'response.header.x-good', match: PATTERN }]],
    ['a condition that is not an object', ['text', { parameter: 'response.header.x-good', match: PATTERN }]],
  ])('loads a rule with %s without widening a mask', async (_label, rule_v2) => {
    const errors: Error[] = [];
    const protection: any = await createProtection({
      rules: EMPTY,
      mode: 'block',
      onError: (error: Error) => errors.push(error),
      responseRules: [{ ...goodRule, rule_v2 }],
    });
    const out = await protection.screenResponse(response());

    expect(out.headers.get('x-other')).toBe(SAMPLE);
    expect(out.headers.get('x-sample')).toBe(SAMPLE);
    // Loading reads past the condition it cannot use. What is reported comes from evaluating the rule,
    // once per evaluation, and not from loading it.
    const fromLoading = errors.filter((e) => /reading 'rules'|reading 'match'|reading 'mutations'/.test(e.message));
    expect(fromLoading).toEqual([]);
  });

  it.each([['match'], ['mutations']])('loads a rule whose condition cannot be read (%s) and reports it', async (property) => {
    const errors: Error[] = [];
    const condition: Record<string, unknown> = { parameter: 'response.header.x-good', match: PATTERN };
    Object.defineProperty(condition, property, { get() { throw new Error('unreadable condition'); }, enumerable: true });
    const protection: any = await createProtection({
      rules: EMPTY,
      mode: 'block',
      onError: (error: Error) => errors.push(error),
      responseRules: [{ ...goodRule, rule_v2: [condition] }],
    });
    // Reported by loading, before any response is screened.
    expect(errors.some((e) => e.message === 'unreadable condition')).toBe(true);

    const out = await protection.screenResponse(response());
    expect(out.headers.get('x-other')).toBe(SAMPLE);
  });

  it('reports a structural condition over a list with null, and withholds a response it matches', async () => {
    const errors: Error[] = [];
    const protection: any = await createProtection({
      rules: EMPTY,
      mode: 'block',
      onError: (error: Error) => errors.push(error),
      responseRules: [{
        ...goodRule,
        rule_v2: [{ parameter: ['response.body', null], mutations: ['json_decode'], match: { type: 'array_key_value', key: 'note', match: { type: 'isset' } } }],
      }],
    });
    const out = await protection.screenResponse(response());

    expect(scopeReports(errors)).toHaveLength(1);
    expect(out.status).toBe(500);
  });
});

describe('a malformed parameter list arriving on a refresh', () => {
  // The rule source validates a delivered bundle against the rule contract, and an update carrying a rule
  // it refuses is rejected whole: the previous rules stay in force. Every malformed list is refused there.
  // (`[undefined]` cannot be delivered: JSON carries it as `[null]`.)
  const previous = { ...goodRule, id: 'previous', rule_v2: [{ parameter: 'response.header.x-other', match: PATTERN }] };

  it.each(malformed.filter(([label]) => label !== '[undefined]'))('rejects an update with %s and keeps the previous rules', async (_label, parameter) => {
    const bundle = { firewall: [badRule(parameter), goodRule], whitelists: [], whitelist_keys: {} };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...EMPTY, firewall: [previous] }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify(bundle), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const errors: Error[] = [];
    const protection: any = await createProtection({
      siteUuid: 's',
      pulseRulesUrl: URL_OPT,
      mode: 'block',
      reportManifest: false,
      onError: (error: Error) => errors.push(error),
    });
    expect(scopeReports(errors)).toHaveLength(0);

    const outcome = await protection.refresh();
    const out = await protection.screenResponse(response());

    expect(outcome).toMatchObject({ ok: false, reason: 'update rejected' });
    expect(errors.some((e) => e.message.includes('rejected the entire update'))).toBe(true);
    expect(scopeReports(errors)).toHaveLength(0);
    // The previous rules are still the ones in force, and the well-formed rule from the refused update is not.
    expect(out.status).toBe(200);
    expect(out.headers.get('x-other')).toBe('[REDACTED]');
    expect(out.headers.get('x-good')).toBe(SAMPLE);
  });
});

describe('a malformed parameter list arriving through the push endpoint', () => {
  it('reports the push as not refreshed and keeps the previous rules', async () => {
    const previous = { ...goodRule, id: 'previous', rule_v2: [{ parameter: 'response.header.x-other', match: PATTERN }] };
    const bundle = { firewall: [badRule(['response.header.x-sample', null]), goodRule], whitelists: [], whitelist_keys: {} };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...EMPTY, firewall: [previous] }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify(bundle), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const errors: Error[] = [];
    const protection: any = await createProtection({
      siteUuid: 's',
      pulseRulesUrl: URL_OPT,
      mode: 'block',
      reportManifest: false,
      refreshSecret: 'sample-secret',
      onError: (error: Error) => errors.push(error),
    });

    const handled = await protection.refreshHandler()(
      new Request('https://app.example.test/_ps/refresh', { headers: { 'x-patchstack-refresh': 'sample-secret' } }),
    );

    expect(handled.status).toBe(200);
    expect(await handled.json()).toEqual({ refreshed: false });
    expect(errors.some((e) => e.message.includes('rejected the entire update'))).toBe(true);
    expect(scopeReports(errors)).toHaveLength(0);
    const out = await protection.screenResponse(response());
    expect(out.status).toBe(200);
    expect(out.headers.get('x-other')).toBe('[REDACTED]');
    expect(out.headers.get('x-sample')).toBe(SAMPLE);
  });
});
