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

const rules = {
  firewall: [{ id: 'proto', title: 'proto', rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '__proto__' } }] }],
  whitelists: [],
  whitelist_keys: {},
};
const jsonReq = (body: string) =>
  new Request('https://app/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('fetch request-body cap', () => {
  it('truncates an oversize body to the cap and still scans the prefix', async () => {
    const overCap = await post('x'.repeat(200), 'text/plain', 32);
    expect(overCap._rawBody).toBe('x'.repeat(32)); // prefix kept for scanning, not discarded

    const underCap = await post('small', 'text/plain', 32);
    expect(underCap._rawBody).toBe('small');
  });

  it('catches a front-loaded payload in an oversize body; a payload pushed past the cap still slips', async () => {
    const p = await createProtection({ rules, mode: 'block' });
    const guard = p.fetchGuard();

    // __proto__ at the front → within the scanned first 1 MiB → blocked.
    const frontLoaded = '{"__proto__":{"x":1},"pad":"' + 'a'.repeat(1024 * 1024 + 64) + '"}';
    expect(await guard(jsonReq(frontLoaded))).not.toBeNull();

    // __proto__ pushed beyond the 1 MiB cap by leading padding → outside the prefix → slips
    // (documented residual: partial-scan can't see past the cap).
    const buried = '{"pad":"' + 'a'.repeat(1024 * 1024 + 64) + '","__proto__":{"x":1}}';
    expect(await guard(jsonReq(buried))).toBeNull();

    // a small body is still fully scanned.
    expect(await guard(jsonReq('{"__proto__":{"x":1}}'))).not.toBeNull();
  });
});
