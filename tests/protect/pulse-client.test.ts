import { afterEach, describe, expect, it, vi } from 'vitest';
import { PulseRuleClient } from '../../src/protect/engine/pulse-client.js';
import { clearPulseToken } from '../../src/pulse-token.js';

const RULES = { firewall: [{ id: 'rm-npm-0001', rule_v2: [{ parameter: 'post.title', match: { type: 'inline_xss' } }] }], whitelists: [], whitelist_keys: {} };

afterEach(() => vi.restoreAllMocks());

describe('PulseRuleClient', () => {
  it('GETs /rules/<uuid> and returns the firewall on 200', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RULES), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new PulseRuleClient({ siteUuid: 'abc-123', baseUrl: 'https://x.test/monitor/pulse' });
    const res = await client.getRules();
    expect(res.success).toBe(true);
    expect(res.firewall[0].id).toBe('rm-npm-0001');
    expect(fetchMock.mock.calls[0][0]).toBe('https://x.test/monitor/pulse/rules/abc-123');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('exchanges the credential and sends a bearer token', async () => {
    clearPulseToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(RULES), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await new PulseRuleClient({
      siteUuid: 'abc-123',
      baseUrl: 'https://x.test/monitor/pulse',
      pulseAuth: 'the-secret-987',
    }).getRules();

    expect(res.success).toBe(true);
    // Exchanged on the same origin, then the rules request carried the token.
    expect(fetchMock.mock.calls[0][0]).toBe('https://x.test/monitor/pulse/token');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer tok');
  });

  it('fetches unauthenticated when no credential is configured', async () => {
    clearPulseToken();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RULES), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await new PulseRuleClient({ siteUuid: 'abc-123', baseUrl: 'https://x.test/monitor/pulse' }).getRules();

    // One call: no exchange attempted, and no Authorization header.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('still fetches rules when the credential exchange fails', async () => {
    clearPulseToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 401 })) // exchange rejected
      .mockResolvedValueOnce(new Response(JSON.stringify(RULES), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await new PulseRuleClient({
      siteUuid: 'abc-123',
      baseUrl: 'https://x.test/monitor/pulse',
      pulseAuth: 'the-secret-987',
    }).getRules();

    // Protection must never hinge on getting a token.
    expect(res.success).toBe(true);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });

  it('fails open (success:false, empty rules) on a non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const res = await new PulseRuleClient({ siteUuid: 'x' }).getRules();
    expect(res.success).toBe(false);
    expect(res.firewall).toEqual([]);
  });

  it('fails open on a thrown fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const res = await new PulseRuleClient({ siteUuid: 'x' }).getRules();
    expect(res.success).toBe(false);
    expect(res.firewall).toEqual([]);
  });

  it('caches within the TTL (one fetch for two calls)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RULES), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new PulseRuleClient({ siteUuid: 'x', cacheTtl: 10_000 });
    await client.getRules();
    await client.getRules();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cache TTL has elapsed', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RULES), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new PulseRuleClient({ siteUuid: 'x', cacheTtl: 10_000 });
    await client.getRules();
    nowSpy.mockReturnValue(10_001); // past the TTL
    await client.getRules();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clearCache() forces the next call to refetch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RULES), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new PulseRuleClient({ siteUuid: 'x', cacheTtl: 10_000 });
    await client.getRules();
    client.clearCache();
    await client.getRules();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires a siteUuid', () => {
    expect(() => new PulseRuleClient({})).toThrow();
  });

  it('parses enforcement from the Pulse rules response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...RULES, enforcement: 'dry-run' }), { status: 200 })),
    );
    const res = await new PulseRuleClient({ siteUuid: 'x' }).getRules();
    expect(res.success).toBe(true);
    expect(res.enforcement).toBe('dry-run');
  });

  it('accepts mode as an alias for enforcement', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...RULES, mode: 'block' }), { status: 200 })),
    );
    const res = await new PulseRuleClient({ siteUuid: 'x' }).getRules();
    expect(res.enforcement).toBe('block');
  });

  it('ignores invalid enforcement values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...RULES, enforcement: 'maybe' }), { status: 200 })),
    );
    const res = await new PulseRuleClient({ siteUuid: 'x' }).getRules();
    expect(res.enforcement).toBeUndefined();
  });
});
