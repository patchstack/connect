import { describe, expect, it } from 'vitest';
import { fromFetchRequest } from '../../src/protect/engine/fetch.js';
import { createProtection } from '../../src/protect/runtime.js';

// The fetch/route-WAF path must not buffer an unbounded request body into memory. Past the cap
// the body is left UNSCANNED (fail-open) — the request is still evaluated on query/headers/url.

const post = (body: string, ct = 'application/json', maxBodyBytes?: number) =>
  fromFetchRequest(
    new Request('https://app/x', { method: 'POST', headers: { 'content-type': ct }, body }),
    maxBodyBytes ? { maxBodyBytes } : {},
  );

describe('fetch request-body cap', () => {
  it('skips a body larger than the cap, keeps a small one', async () => {
    const overCap = await post('x'.repeat(200), 'text/plain', 32);
    expect(overCap._rawBody).toBe('');
    expect(overCap.body).toEqual({});

    const underCap = await post('small', 'text/plain', 32);
    expect(underCap._rawBody).toBe('small');
  });

  it('does not block a malicious payload buried in an oversized body (fail-open)', async () => {
    const rules = {
      firewall: [{ id: 'proto', title: 'proto', rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '__proto__' } }] }],
      whitelists: [],
      whitelist_keys: {},
    };
    const p = await createProtection({ rules, mode: 'block' });
    const guard = p.fetchGuard();

    const huge = '{"__proto__":{"x":1},"pad":"' + 'a'.repeat(1024 * 1024 + 64) + '"}';
    const oversized = await guard(new Request('https://app/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: huge }));
    expect(oversized).toBeNull(); // over the 1 MiB cap → body unscanned → allowed

    const small = await guard(new Request('https://app/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"__proto__":{"x":1}}' }));
    expect(small).not.toBeNull(); // within cap → scanned → blocked
  });
});
