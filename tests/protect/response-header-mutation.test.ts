import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// Response-hardening actions: set-header (with `ensure`), remove-header, harden-cookie. When a rule
// matches, it mutates the outgoing response's headers instead of blocking the whole response — the
// right mitigation for CORS misconfig, security-header insertion, and cookie hardening.

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
const alwaysCond = [{ parameter: 'response.status', match: { type: 'isset' } }]; // matches every response
const json = (headers: Record<string, string>) =>
  new Response('{}', { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const withRule = (rule: any, mode = 'block') =>
  createProtection({ rules: emptyBundle, responseRules: [rule], mode });

describe('response header mutation', () => {
  it('remove-header strips the offending headers (e.g. a CORS misconfig) while serving the response', async () => {
    const rule = {
      phase: 'response',
      category: 'cors',
      action: 'remove-header',
      remove_headers: ['access-control-allow-origin', 'access-control-allow-credentials'],
      rule_v2: [{ parameter: 'response.header.access-control-allow-credentials', match: { type: 'equals', value: 'true' } }],
    };
    const p: any = await withRule(rule);
    const out = await p.screenResponse(json({ 'access-control-allow-origin': 'https://evil.com', 'access-control-allow-credentials': 'true' }));
    expect(out.status).toBe(200); // NOT blocked — served, but hardened
    expect(out.headers.get('access-control-allow-credentials')).toBeNull();
    expect(out.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('set-header with ensure adds security headers when absent, and never clobbers an existing one', async () => {
    const rule = {
      phase: 'response',
      action: 'set-header',
      ensure: true,
      set_headers: { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' },
      rule_v2: alwaysCond,
    };
    const p: any = await withRule(rule);
    const added = await p.screenResponse(json({}));
    expect(added.headers.get('x-content-type-options')).toBe('nosniff');
    expect(added.headers.get('x-frame-options')).toBe('DENY');

    const existing = await p.screenResponse(json({ 'x-frame-options': 'SAMEORIGIN' }));
    expect(existing.headers.get('x-frame-options')).toBe('SAMEORIGIN'); // ensure → preserved
  });

  it('set-header without ensure overwrites', async () => {
    const rule = { phase: 'response', action: 'set-header', set_headers: { 'x-frame-options': 'DENY' }, rule_v2: alwaysCond };
    const p: any = await withRule(rule);
    const out = await p.screenResponse(json({ 'x-frame-options': 'SAMEORIGIN' }));
    expect(out.headers.get('x-frame-options')).toBe('DENY');
  });

  it('harden-cookie adds missing HttpOnly/Secure/SameSite without duplicating existing flags', async () => {
    const rule = { phase: 'response', action: 'harden-cookie', rule_v2: alwaysCond };
    const p: any = await withRule(rule);

    const out = await p.screenResponse(json({ 'set-cookie': 'session=abc' }));
    const cookie = out.headers.getSetCookie()[0];
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const already = await p.screenResponse(json({ 'set-cookie': 'session=abc; HttpOnly' }));
    const cookie2 = already.headers.getSetCookie()[0];
    expect((cookie2.match(/HttpOnly/gi) || []).length).toBe(1); // not duplicated
  });

  it('mutates headers on a bodyless redirect (302) and preserves status + Location', async () => {
    const rule = { phase: 'response', action: 'set-header', set_headers: { 'x-frame-options': 'DENY' }, rule_v2: alwaysCond };
    const p: any = await withRule(rule);
    const out = await p.screenResponse(new Response(null, { status: 302, headers: { location: '/dashboard' } }));
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('/dashboard');
    expect(out.headers.get('x-frame-options')).toBe('DENY');
  });

  it('serves the response when a rule names a header the platform rejects', async () => {
    // Fail-open, on the header-mutation path. `Headers.get` throws on an invalid field name exactly as
    // `set` does, and it ran first, outside the guard — so a rule carrying an unusable name crashed
    // response screening instead of skipping the mutation. The contract refuses such a rule now, but a
    // bundle written before it, or rules passed straight to `responseRules`, still arrive here.
    for (const name of ['', 'x bad', 'x-bad\nInjected']) {
      const p: any = await withRule({ phase: 'response', action: 'set-header', set_headers: { [name]: 'x' }, rule_v2: alwaysCond });
      const out = await p.screenResponse(json({ 'x-keep': 'kept' }));
      expect(out.status, name).toBe(200);
      expect(out.headers.get('x-keep'), name).toBe('kept'); // and the rest of the response is intact
    }
  });

  it('emits SameSite only for a value the attribute actually takes', async () => {
    // The flag is interpolated into Set-Cookie, so an unrecognised value is a header the browser
    // ignores, and one carrying `;` appends further cookie attributes — `Lax; Domain=evil.test` becomes
    // a Domain the rule never declared. The contract refuses both, and this is the runtime's own guard
    // for rules written before it, or handed straight to `responseRules`.
    const harden = async (cookie_flags: any) => {
      const p: any = await withRule({ phase: 'response', action: 'harden-cookie', cookie_flags, rule_v2: alwaysCond });
      const out = await p.screenResponse(json({ 'set-cookie': 'sid=abc; Path=/' }));
      return out.headers.getSetCookie()[0];
    };

    expect(await harden({ sameSite: 'Lax; Domain=evil.test' })).toBe('sid=abc; Path=/; HttpOnly; Secure');
    expect(await harden({ sameSite: 'Banana' })).toBe('sid=abc; Path=/; HttpOnly; Secure');
    expect(await harden({ sameSite: 'Strict' })).toBe('sid=abc; Path=/; HttpOnly; Secure; SameSite=Strict');
    expect(await harden({ sameSite: 'none' })).toBe('sid=abc; Path=/; HttpOnly; Secure; SameSite=None');
    expect(await harden(undefined)).toBe('sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax');
  });

  it('does not mutate in dry-run (observe only)', async () => {
    const rule = { phase: 'response', action: 'remove-header', remove_headers: ['x-secret'], rule_v2: alwaysCond };
    const p: any = await withRule(rule, 'dry-run');
    const out = await p.screenResponse(json({ 'x-secret': 'value' }));
    expect(out.headers.get('x-secret')).toBe('value'); // unchanged
  });
});
