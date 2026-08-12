import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// `off_origin` (response phase): flags a 3xx whose Location points to a different origin than the
// request Host — the open-redirect primitive, enabled by threading the request into the response
// phase. Not a default (many apps redirect off-site legitimately); authored + route-scoped.

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
const rule = (when?: any) => ({
  phase: 'response',
  category: 'open-redirect',
  action: 'block',
  ...(when ? { when } : {}),
  rule_v2: [{ match: { type: 'off_origin' } }],
});
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
const req = (url: string) => new Request(url);
const setup = (when?: any) =>
  createProtection({ rules: emptyBundle, responseRules: [rule(when)], mode: 'block' });

describe('off_origin — open-redirect detection', () => {
  it('blocks a 3xx that redirects to a different origin', async () => {
    const p: any = await setup();
    const out = await p.screenResponse(redirect('https://evil.com/x'), req('https://app.example.com/go'));
    expect(out.status).toBe(500); // redirect withheld
  });

  it('allows a same-origin absolute redirect', async () => {
    const p: any = await setup();
    const out = await p.screenResponse(redirect('https://app.example.com/dashboard'), req('https://app.example.com/go'));
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('https://app.example.com/dashboard');
  });

  it('allows a relative (same-origin) redirect', async () => {
    const p: any = await setup();
    const out = await p.screenResponse(redirect('/dashboard'), req('https://app.example.com/go'));
    expect(out.status).toBe(302);
  });

  it('does not flag a non-3xx response that carries a Location header', async () => {
    const p: any = await setup();
    const out = await p.screenResponse(redirect('https://evil.com/x', 200), req('https://app.example.com/go'));
    expect(out.status).toBe(200);
  });

  it('is lenient with no request context (no Host to compare against)', async () => {
    const p: any = await setup();
    const out = await p.screenResponse(redirect('https://evil.com/x')); // no request passed
    expect(out.status).toBe(302);
  });

  it('honours `when` route scope — blocks on the scoped route only', async () => {
    const p: any = await setup({ path: '/go' });
    const onScope = await p.screenResponse(redirect('https://evil.com/x'), req('https://app.example.com/go'));
    expect(onScope.status).toBe(500);
    const offScope = await p.screenResponse(redirect('https://evil.com/x'), req('https://app.example.com/elsewhere'));
    expect(offScope.status).toBe(302);
  });
});
