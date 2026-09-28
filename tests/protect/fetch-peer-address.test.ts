import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection, createSupabaseGuard, GUARD_PATH } from '../../src/protect/runtime.js';

// A Fetch runtime's Request carries no transport peer. `peerAddress` lets the host supply the one it
// knows, and that address then counts as the peer, including for a declared proxy policy.

const addressRule = () => ({
  firewall: [{
    id: 'address-under-test', title: 'address under test',
    rule_v2: [{ parameter: 'server.ip', match: { type: 'contains', value: '198.51.100.' } }],
  }],
  whitelists: [],
  whitelist_keys: {},
});

async function guardWith(options: Record<string, unknown>) {
  const detections: any[] = [];
  const errors: unknown[] = [];
  const protection: any = await createProtection({
    rules: addressRule(),
    mode: 'dry-run',
    onDetect: (event: any) => detections.push(event),
    onError: (err: unknown) => errors.push(err),
    ...options,
  });
  return { protection, detections, errors };
}

const request = (headers: Record<string, string> = {}) => new Request('https://app.example.test/', { headers });

afterEach(() => vi.restoreAllMocks());

describe('Fetch peer address', () => {
  it('uses the address the host supplies', async () => {
    const { protection, detections } = await guardWith({ peerAddress: () => '198.51.100.7' });
    await protection.fetchGuard()(request());
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({ ip: '198.51.100.7', clientIpSource: 'runtime' });
    await protection.stop();
  });

  it('passes the host handler arguments to the callback', async () => {
    const info = { remoteAddr: { hostname: '198.51.100.9' } };
    const peerAddress = vi.fn((_req: Request, hostInfo: any) => hostInfo.remoteAddr.hostname);
    const { protection, detections } = await guardWith({ peerAddress });
    const served = request();
    await protection.fetch(async () => new Response('sample'))(served, info);
    expect(peerAddress).toHaveBeenCalledWith(served, info);
    expect(detections[0]).toMatchObject({ ip: '198.51.100.9', clientIpSource: 'runtime' });
    await protection.stop();
  });

  it('applies a declared proxy policy to the supplied peer', async () => {
    const { protection, detections, errors } = await guardWith({
      peerAddress: () => '10.0.0.5',
      trustedProxy: { peers: ['10.0.0.0/8'] },
    });
    await protection.fetchGuard()(request({ 'x-forwarded-for': '198.51.100.20' }));
    expect(detections[0]).toMatchObject({ ip: '198.51.100.20', clientIpSource: 'trusted-proxy' });
    expect(errors).toHaveLength(0);
    await protection.stop();
  });

  it('does not believe a forwarded header from a peer outside the policy', async () => {
    const { protection, detections } = await guardWith({
      peerAddress: () => '203.0.113.5',
      trustedProxy: { peers: ['10.0.0.0/8'] },
    });
    await protection.fetchGuard()(request({ 'x-forwarded-for': '198.51.100.20' }));
    expect(detections).toHaveLength(0);
    await protection.stop();
  });

  it('keeps the unavailable result without a callback, and warns once when a policy is set', async () => {
    const { protection, detections, errors } = await guardWith({ trustedProxy: { peers: ['10.0.0.0/8'] } });
    await protection.fetchGuard()(request({ 'x-forwarded-for': '198.51.100.20' }));
    await protection.fetchGuard()(request({ 'x-forwarded-for': '198.51.100.21' }));
    expect(detections).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toContain('peerAddress');
    await protection.stop();
  });

  it('warns on the console when no onError is given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const protection: any = await createProtection({ rules: addressRule(), trustedProxy: { hops: 1 } });
    await protection.fetchGuard()(request());
    await protection.fetchGuard()(request());
    expect(warn.mock.calls.filter(([m]) => String(m).includes('peerAddress'))).toHaveLength(1);
    await protection.stop();
  });

  it.each([['a non-address', () => 'not-an-address'], ['a non-string', () => 42]])(
    'warns once with a policy when the callback returns %s', async (_label, peerAddress) => {
      const { protection, errors } = await guardWith({ peerAddress, trustedProxy: { peers: ['10.0.0.0/8'] } });
      await protection.fetchGuard()(request());
      await protection.fetchGuard()(request());
      expect(errors).toHaveLength(1);
      await protection.stop();
    },
  );

  it('does not warn without a policy', async () => {
    const { protection, errors } = await guardWith({});
    await protection.fetchGuard()(request());
    expect(errors).toHaveLength(0);
    await protection.stop();
  });

  it.each([
    ['throws', () => { throw new Error('sample'); }, 1],
    ['returns a non-string', () => 42, 0],
    ['returns an empty string', () => '', 0],
  ])('supplies no peer when the callback %s', async (_label, peerAddress, errorCount) => {
    const { protection, detections, errors } = await guardWith({ peerAddress });
    const blocked = await protection.fetchGuard()(request());
    expect(blocked).toBeNull();
    expect(detections).toHaveLength(0);
    expect(errors).toHaveLength(errorCount);
    await protection.stop();
  });

  it('gives the response phase the address the request phase resolved', async () => {
    const detections: any[] = [];
    const protection: any = await createProtection({
      rules: { firewall: [], whitelists: [], whitelist_keys: {} },
      mode: 'dry-run',
      peerAddress: () => '198.51.100.30',
      onDetect: (event: any) => detections.push(event),
      responseRules: [{
        id: 'response-under-test', phase: 'response', action: 'redact',
        rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'SAMPLE_VALUE' } }],
      }],
    });
    const served = request();
    await protection.fetchGuard()(served);
    await protection.screenResponse(new Response('SAMPLE_VALUE'), served);
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({ phase: 'response', ip: '198.51.100.30', clientIpSource: 'runtime' });
    await protection.stop();
  });

  it('reads the peer from the served request through the Supabase tunnel', async () => {
    const supabase = 'https://project.supabase.example';
    const served = new Request('https://app.example.test' + GUARD_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ps-target': supabase + '/rest/v1/items' },
      body: '{}',
    });
    const peerAddress = vi.fn((req: Request, server: any) => server.requestIP(req)?.address);
    const server = { requestIP: (req: Request) => (req === served ? { address: '198.51.100.40' } : null) };
    const { protection, detections } = await guardWith({ peerAddress });
    const handle = createSupabaseGuard({
      protection,
      supabaseUrl: supabase,
      fetchImpl: (async () => new Response('[]', { headers: { 'content-type': 'application/json' } })) as any,
    });
    const response = await handle(served, server);
    expect(response.status).toBe(200);
    expect(detections[0]).toMatchObject({ ip: '198.51.100.40', clientIpSource: 'runtime' });
    await protection.stop();
  });
});
