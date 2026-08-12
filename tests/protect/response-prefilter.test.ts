import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// A response rule may declare a cheap literal `prefilter`; screenText runs the rule's (expensive)
// regex only when at least one anchor is present in the body. This cuts CPU/latency on the common
// no-candidate response and shrinks the regex/ReDoS surface.

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
const textResp = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });

const rule = (prefilter?: string[]) => ({
  phase: 'response',
  category: 'x',
  action: 'redact',
  ...(prefilter ? { prefilter } : {}),
  rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/topsecret/' } }],
});

describe('response phase — literal prefilter short-circuit', () => {
  it('skips the regex when no prefilter anchor is present (rule does not fire)', async () => {
    const p: any = await createProtection({ rules: emptyBundle, responseRules: [rule(['zz-absent-marker'])], mode: 'block' });
    const out = await p.screenResponse(textResp('a topsecret b')); // regex WOULD match, but the anchor is absent
    expect(await out.text()).toBe('a topsecret b'); // short-circuited → untouched
  });

  it('runs the rule when a prefilter anchor is present', async () => {
    const p: any = await createProtection({ rules: emptyBundle, responseRules: [rule(['topsecret'])], mode: 'block' });
    const out = await p.screenResponse(textResp('a topsecret b'));
    expect(/topsecret/.test(await out.text())).toBe(false); // fired → masked
  });

  it('matches the prefilter case-insensitively', async () => {
    const p: any = await createProtection({ rules: emptyBundle, responseRules: [rule(['TOPSECRET'])], mode: 'block' });
    const out = await p.screenResponse(textResp('a topsecret b'));
    expect(/topsecret/.test(await out.text())).toBe(false);
  });

  it('a rule with no prefilter runs as before (back-compat)', async () => {
    const p: any = await createProtection({ rules: emptyBundle, responseRules: [rule()], mode: 'block' });
    const out = await p.screenResponse(textResp('a topsecret b'));
    expect(/topsecret/.test(await out.text())).toBe(false);
  });
});
