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
    expect(overCap._bodyInspectionSkip).toBe('body-cap');

    const underCap = await post('small', 'text/plain', 32);
    expect(underCap._rawBody).toBe('small');
    expect(underCap._bodyInspectionSkip).toBeUndefined();
  });

  it('returns after the cap without waiting for the rest of an open stream', async () => {
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode('12345678'));
      },
    });
    const request = new Request('https://app/x', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: string });

    const shaped: any = await Promise.race([
      fromFetchRequest(request, { maxBodyBytes: 32 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('inspection waited for EOF')), 250)),
    ]);

    expect(shaped._rawBody).toBe('12345678'.repeat(4));
    expect(shaped._bodyInspectionSkip).toBe('body-cap');
    expect(pulls).toBeLessThan(20);
    void request.body?.cancel().catch(() => {});
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
