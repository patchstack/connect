import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// The response phase now receives the originating request, so a response rule's `when` route/method
// scope resolves against the REAL request instead of a phantom empty one (where it was inert). This
// is the enabling change for route-scoped response rules and, later, open-redirect / CORS / IDOR
// rules that need request Host/Origin/identity.

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };

const redactOnAdmin = {
  phase: 'response',
  category: 'x',
  action: 'redact',
  when: { path: '/admin', method: ['GET'] },
  rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'topsecret' } }],
};

const body = () => new Response('x topsecret y', { status: 200, headers: { 'content-type': 'text/plain' } });

describe('response phase — `when` route/method scope resolves against the request', () => {
  it('applies a route-scoped response rule on the matching route', async () => {
    const p: any = await createProtection({ rules: emptyBundle, responseRules: [redactOnAdmin], mode: 'block' });
    const out = await p.screenResponse(body(), new Request('https://app.example.com/admin', { method: 'GET' }));
    // Before threading the request, `when` resolved REQUEST_URI to '/', so this rule never fired and
    // the secret was served. Now it fires on /admin and masks.
    expect(/topsecret/.test(await out.text())).toBe(false);
  });

  it('does NOT apply the rule on a non-matching route', async () => {
    const p: any = await createProtection({ rules: emptyBundle, responseRules: [redactOnAdmin], mode: 'block' });
    const out = await p.screenResponse(body(), new Request('https://app.example.com/public', { method: 'GET' }));
    expect(/topsecret/.test(await out.text())).toBe(true); // out of scope → untouched
  });

  it('does NOT apply the rule on a non-matching method', async () => {
    const p: any = await createProtection({ rules: emptyBundle, responseRules: [redactOnAdmin], mode: 'block' });
    const out = await p.screenResponse(body(), new Request('https://app.example.com/admin', { method: 'POST' }));
    expect(/topsecret/.test(await out.text())).toBe(true); // method out of scope → untouched
  });

  it('an unscoped response rule still works with no request context (back-compat)', async () => {
    const rule = { ...redactOnAdmin, when: undefined };
    const p: any = await createProtection({ rules: emptyBundle, responseRules: [rule], mode: 'block' });
    const out = await p.screenResponse(body()); // no request passed
    expect(/topsecret/.test(await out.text())).toBe(false);
  });
});
