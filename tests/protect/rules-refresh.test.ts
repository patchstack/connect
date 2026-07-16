import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeStore } from '../../src/protect/rules/store.js';
import { createProtection } from '../../src/protect/runtime.js';

afterEach(() => vi.restoreAllMocks());

const RULES = { firewall: [{ id: 'rm-npm-0001', rule_v2: [{ parameter: 'get.q', match: { type: 'isset' } }] }], whitelists: [], whitelist_keys: {} };
const EMPTY = { firewall: [], whitelists: [], whitelist_keys: {} };
const URL_OPT = 'https://x.test/monitor/pulse';

describe('tiered rule store', () => {
  it('memory tier serves last-known-good when the durable write fails', async () => {
    let disk: unknown = null;
    const store = makeStore({ ruleCache: { read: () => disk, write: () => { throw new Error('read-only FS'); } } });
    await store.write({ bundle: RULES, etag: 'v1' });
    expect(disk).toBeNull(); // durable write threw…
    expect((await store.read()) as any).toMatchObject({ etag: 'v1' }); // …but memory kept it
  });

  it('reads durable once, then serves from memory', async () => {
    let reads = 0;
    const durable = { bundle: RULES, etag: 'e' };
    const store = makeStore({ ruleCache: { read: () => { reads++; return durable; }, write: () => {} } });
    expect(((await store.read()) as any).etag).toBe('e');
    await store.read();
    expect(reads).toBe(1); // second read came from the memory tier
  });
});

describe('manual refresh()', () => {
  it('re-fetches and hot-swaps the rules in place', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(EMPTY), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify(RULES), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const p: any = await createProtection({ siteUuid: 's', pulseRulesUrl: URL_OPT, mode: 'block', reportManifest: false });
    expect(p.rules.request).toHaveLength(0);
    await p.refresh();
    expect(p.rules.request.length).toBeGreaterThan(0);
  });
});

describe('push refresh endpoint (refreshHandler)', () => {
  it('runs a refresh only for a request carrying the configured secret', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(EMPTY), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify(RULES), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const p: any = await createProtection({ siteUuid: 's', pulseRulesUrl: URL_OPT, mode: 'block', reportManifest: false, refreshSecret: 'sekret' });
    const handler = p.refreshHandler();

    expect((await handler(new Request('https://app/_ps/refresh'))).status).toBe(403); // no secret
    expect(p.rules.request).toHaveLength(0);

    const ok = await handler(new Request('https://app/_ps/refresh', { headers: { 'x-patchstack-refresh': 'sekret' } }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).refreshed).toBe(true);
    expect(p.rules.request.length).toBeGreaterThan(0); // refreshed
  });

  it('404s when no refresh secret is configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(EMPTY), { status: 200 })));
    const p: any = await createProtection({ siteUuid: 's', pulseRulesUrl: URL_OPT, mode: 'block', reportManifest: false });
    const res = await p.refreshHandler()(new Request('https://app/x?token=anything'));
    expect(res.status).toBe(404);
  });
});
