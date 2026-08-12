import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// `cors_reflected` (response phase): flags a response that allows credentials AND reflects the
// caller's Origin (or uses `*`) into Access-Control-Allow-Origin — letting any site read the
// authenticated response. Enabled by threading the request into the response phase. Authored +
// route-scoped (not a default).

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
const rule = (when?: any) => ({
  phase: 'response',
  category: 'cors',
  action: 'block',
  ...(when ? { when } : {}),
  rule_v2: [{ match: { type: 'cors_reflected' } }],
});
const resp = (acao: string | null, acac: string | null = 'true') => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (acao !== null) headers['access-control-allow-origin'] = acao;
  if (acac !== null) headers['access-control-allow-credentials'] = acac;
  return new Response(JSON.stringify({ secret: 'data' }), { status: 200, headers });
};
const req = (origin?: string) =>
  new Request('https://app.example.com/api', { headers: origin ? { origin } : {} });
const setup = (when?: any) =>
  createProtection({ rules: emptyBundle, responseRules: [rule(when)], mode: 'block' });

describe('cors_reflected — CORS-misconfiguration detection', () => {
  it('blocks a credentialed response that reflects the caller Origin', async () => {
    const p: any = await setup();
    const out = await p.screenResponse(resp('https://evil.com'), req('https://evil.com'));
    expect(out.status).toBe(500); // withheld — the cross-origin read is prevented
  });

  it('blocks a credentialed wildcard (ACAO: *) response', async () => {
    const p: any = await setup();
    const out = await p.screenResponse(resp('*'), req('https://evil.com'));
    expect(out.status).toBe(500);
  });

  it('allows a fixed (non-reflected) allowlisted origin with credentials', async () => {
    const p: any = await setup();
    const out = await p.screenResponse(resp('https://trusted.example.com'), req('https://evil.com'));
    expect(out.status).toBe(200); // fixed allowlist ≠ caller Origin → safe
  });

  it('allows reflection WITHOUT credentials (not the dangerous combination)', async () => {
    const p: any = await setup();
    const out = await p.screenResponse(resp('https://evil.com', 'false'), req('https://evil.com'));
    expect(out.status).toBe(200);
  });

  it('allows a response with no CORS headers', async () => {
    const p: any = await setup();
    const out = await p.screenResponse(resp(null, null), req('https://evil.com'));
    expect(out.status).toBe(200);
  });

  it('honours `when` route scope', async () => {
    const p: any = await setup({ path: '/api' });
    const onScope = await p.screenResponse(resp('*'), req('https://evil.com'));
    expect(onScope.status).toBe(500);
    // same misconfig on a different route → out of scope → allowed
    const other = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' },
    });
    const offScope = await p.screenResponse(other, new Request('https://app.example.com/other', { headers: { origin: 'https://evil.com' } }));
    expect(offScope.status).toBe(200);
  });
});
