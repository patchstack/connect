import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// The static-rule-through-Pulse chain the pilot ships and demo-pulse-chain.mjs showcases:
// a rule is fetched from Pulse by site UUID, enforced through the .fetch() HTTP guard, then
// PROMOTED dry-run -> block remotely via a manual refresh, with ETag conditional revalidation.
// (runtime-pulse.test.ts covers the server-fn guard + timer-driven hot-swap; this pins the
// HTTP guard path, the manual refresh() promotion, and the 304 revalidation.)

const lodashRule = {
  id: 'PS-CVE-2019-10744',
  title: 'Prototype pollution in lodash',
  category: 'prototype-pollution',
  rule_v2: [
    { parameter: 'raw', mutations: ['urldecode'], match: { type: 'contains', value: '__proto__' } },
    { parameter: 'rules', rules: [
      { parameter: 'raw', mutations: ['urldecode'], match: { type: 'contains', value: 'constructor' }, inclusive: true },
      { parameter: 'raw', mutations: ['urldecode'], match: { type: 'contains', value: 'prototype' }, inclusive: true },
    ] },
  ],
};

// A mock Pulse endpoint with a mutable enforcement + ETag that honors If-None-Match -> 304,
// exactly like the mock server in demo-pulse-chain.mjs but with no real socket (CI-safe).
function mockPulse() {
  const state = { enforcement: 'dry-run', etag: '"v1"' };
  const calls: Array<{ status: number; ifNoneMatch?: string }> = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const inm = (init?.headers as Record<string, string> | undefined)?.['If-None-Match'];
    if (inm === state.etag) {
      calls.push({ status: 304, ifNoneMatch: inm });
      return new Response(null, { status: 304, headers: { ETag: state.etag } });
    }
    calls.push({ status: 200, ifNoneMatch: inm });
    return new Response(
      JSON.stringify({ firewall: [lodashRule], whitelists: [], whitelist_keys: {}, enforcement: state.enforcement }),
      { status: 200, headers: { 'Content-Type': 'application/json', ETag: state.etag } },
    );
  });
  return { state, calls, fetchMock };
}

const exploit = () => new Request('https://app.demo/api/settings', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: '{"constructor":{"prototype":{"polluted":"yes"}}}',
});
const benign = () => new Request('https://app.demo/api/settings', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"theme":"dark"}',
});
const appHandler = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('static-rule-through-Pulse chain (HTTP guard + manual refresh promotion)', () => {
  const prevMode = process.env.PATCHSTACK_MODE;
  afterEach(() => {
    if (prevMode === undefined) delete process.env.PATCHSTACK_MODE;
    else process.env.PATCHSTACK_MODE = prevMode;
    vi.restoreAllMocks();
  });

  it('fetches from Pulse, honors dry-run, then a manual refresh promotes to block; ETag revalidates', async () => {
    delete process.env.PATCHSTACK_MODE;
    const { state, calls, fetchMock } = mockPulse();
    vi.stubGlobal('fetch', fetchMock);
    const detections: Array<{ rule?: { id?: string } }> = [];

    const p = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      onDetect: (d: { rule?: { id?: string } }) => detections.push(d),
    });

    // 1. Rule arrived over HTTP; guard adopted Pulse's dry-run enforcement.
    expect(calls[0].status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe('https://x.test/monitor/pulse/rules/site-1');
    expect(p.mode).toBe('dry-run');

    // 2. Dry-run: the exploit is detected + logged but still served (guard passes through).
    const dryRes = await p.fetch(appHandler)(exploit());
    expect(dryRes.status).toBe(200);
    expect(detections.some((d) => d.rule?.id === 'PS-CVE-2019-10744')).toBe(true);

    // 3. Remote promotion: Pulse flips enforcement -> block (new ETag); a manual refresh hot-swaps.
    state.enforcement = 'block';
    state.etag = '"v2"';
    await p.refresh();
    expect(p.mode).toBe('block');

    // 4. Block: the SAME exploit is now rejected (403); the sink never runs.
    const blockedRes = await p.fetch(appHandler)(exploit());
    expect(blockedRes.status).toBe(403);
    // 5. Benign traffic is unaffected.
    expect((await p.fetch(appHandler)(benign())).status).toBe(200);

    // 6. A refresh with no change revalidates as 304 (conditional fetch, no body re-sent).
    const before = calls.length;
    await p.refresh();
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1]).toMatchObject({ status: 304, ifNoneMatch: '"v2"' });
    expect(p.mode).toBe('block'); // 304 keeps the last-known-good enforcement

    p.stopRefresh?.();
  });
});
