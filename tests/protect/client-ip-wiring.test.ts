import { describe, it, expect, vi, afterEach } from 'vitest';
import { RuleEngine } from '../../src/protect/engine/engine.js';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * One resolved address per request, shared by every consumer.
 *
 * Rule matching, the detection record and the block log each need a client address. If they derive it
 * separately they can disagree, and one request then appears as several clients — which is worse than
 * having no address, because each value looks authoritative.
 *
 * So the resolution happens once and is threaded. These tests assert the sharing rather than the
 * resolver's own rules, which are covered exhaustively elsewhere.
 */
const RULES = {
  firewall: [
    {
      id: 'ip-rule',
      title: 'address under test',
      // The rule reads the address, so what the engine resolved is observable in the outcome.
      rule_v2: [{ parameter: 'server.ip', match: { type: 'contains', value: '198.51.100.' } }],
    },
  ],
  whitelists: [],
  whitelist_keys: {},
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('one resolution per request, reused everywhere', () => {
  it('gives the rule, the detection and the block record the same address, resolving once', async () => {
    const detections: any[] = [];
    // The block log's real path: the reporter posts what the fan-out handed it, so the posted record is
    // the discriminating observation rather than an intermediate callback.
    const logged: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      // The reporter exchanges the credential for a token before it can post anything.
      if (target.includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt-abc', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/api/logs/log')) {
        // Form-encoded, with the records as a JSON field — the shape the block-log endpoint takes.
        const form = new URLSearchParams(String(init?.body ?? ''));
        logged.push(...JSON.parse(form.get('logs') ?? '[]'));
      }

      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    // The predicate is the resolver's only entry point for this policy, so counting its calls counts the
    // resolutions.
    const seen: string[] = [];
    const isTrusted = vi.fn((ip: string) => {
      seen.push(ip);

      // The deployment's own range. Trusting only the peer would make the charted hop `10.0.0.3` the
      // client, which is correct behaviour for that policy but not the case under test here.
      return ip.startsWith('10.');
    });

    const p: any = await createProtection({
      rules: RULES,
      mode: 'block',
      trustedProxy: { isTrusted },
      onDetect: (d: any) => detections.push(d),
      // Enough for the block-log reporter to exist and post.
      apiKey: 'secret0000000000000000000000000000000000-12345',
      fetchImpl,
    });

    // A Node-shaped request, because a transport peer is what makes a forwarded header usable at all.
    const req: any = {
      method: 'POST',
      url: '/checkout',
      originalUrl: '/checkout',
      headers: { 'x-forwarded-for': '198.51.100.44, 10.0.0.3', 'user-agent': 'probe/1.0' },
      socket: { remoteAddress: '10.0.0.7' },
      readableEnded: true,
      body: {},
    };
    let blockedStatus: number | null = null;
    const res: any = {
      statusCode: 200,
      setHeader() {}, getHeader() {}, removeHeader() {},
      writeHead(code: number) { blockedStatus = code; return this; },
      end() { return this; },
      status(code: number) { blockedStatus = code; return this; },
      json() { return this; }, send() { return this; }, type() { return this; },
    };

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      p.express()(req, res, finish);
      setTimeout(finish, 30);
    });

    // 1. The rule saw the resolved address — it matched, so the request was blocked.
    expect(blockedStatus, 'the rule matched the resolved address').toBe(403);

    // 2. The detection names that identical address and its provenance.
    expect(detections.length).toBeGreaterThan(0);
    expect(detections[0].ip).toBe('198.51.100.44');
    expect(detections[0].clientIpSource).toBe('trusted-proxy');

    // 3. The block-log reporter received the same address, on its own path.
    p.stop();
    await new Promise((r) => setTimeout(r, 10));
    expect(logged.length, 'a block record was posted').toBeGreaterThan(0);
    expect(logged[0].ip).toBe('198.51.100.44');
    expect(logged[0].fid).toBe('ip-rule');

    // 4. Resolved once. The predicate is the resolver's only entry point for this policy, so its calls
    // are the resolutions: the peer, then the chain walked inward until an untrusted address. A second
    // consumer deriving its own address would repeat that sequence.
    expect(seen).toEqual(['10.0.0.7', '10.0.0.3', '198.51.100.44']);
  });

  it('leaves the address absent everywhere in a runtime with no peer', async () => {
    // 5. A generic Fetch runtime exposes no transport peer, so there is no address to report. It is
    // omitted rather than filled in from a header the caller could have written, and the provenance says
    // which case this is.
    const detections: any[] = [];
    const p: any = await createProtection({
      rules: {
        firewall: [
          {
            id: 'any-request',
            title: 'fires on every request',
            rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }],
          },
        ],
        whitelists: [],
        whitelist_keys: {},
      },
      mode: 'dry-run',
      trustedProxy: { isTrusted: () => true },
      onDetect: (d: any) => detections.push(d),
    });

    await p.fetchGuard()(
      new Request('https://app.test/api?q=boom', { headers: { 'x-forwarded-for': '198.51.100.44' } }),
    );

    expect(detections.length).toBeGreaterThan(0);
    expect(detections[0].ip, 'no address is invented from a header').toBeNull();
    expect(detections[0].clientIpSource).toBe('unavailable');
  });

  it('does not let a rule read an address the resolution refused', async () => {
    // A peer the transport could not identify resolves to nothing. A consumer reaching past the
    // resolution to the socket would hand the rule `::` — an address that identifies no one — and the
    // rule would match on it.
    const detections: any[] = [];
    const p: any = await createProtection({
      rules: {
        firewall: [
          {
            id: 'colon-rule',
            title: 'matches an unspecified peer leaking through',
            rule_v2: [{ parameter: 'server.ip', match: { type: 'contains', value: ':' } }],
          },
        ],
        whitelists: [],
        whitelist_keys: {},
      },
      mode: 'block',
      onDetect: (d: any) => detections.push(d),
    });

    const req: any = {
      method: 'GET',
      url: '/x',
      originalUrl: '/x',
      headers: {},
      socket: { remoteAddress: '::' },
      readableEnded: true,
      body: {},
    };
    let status: number | null = null;
    const res: any = {
      statusCode: 200,
      setHeader() {}, getHeader() {}, removeHeader() {},
      writeHead(code: number) { status = code; return this; },
      end() { return this; },
      status(code: number) { status = code; return this; },
      json() { return this; }, send() { return this; }, type() { return this; },
    };

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      p.express()(req, res, finish);
      setTimeout(finish, 30);
    });

    expect(status, 'an unidentifiable peer must not reach a rule').toBeNull();
    expect(detections).toEqual([]);
    p.stop();
  });

  it('does not let a rule read an address invented from a header', async () => {
    // The rule reads `server.ip`. In a runtime with no transport peer there is no address, so a forwarded
    // header must not become one — for the engine any more than for the record.
    const detections: any[] = [];
    const p: any = await createProtection({
      rules: RULES,
      mode: 'block',
      trustedProxy: { isTrusted: () => true },
      onDetect: (d: any) => detections.push(d),
    });

    const blocked = await p.fetchGuard()(
      new Request('https://app.test/api', { headers: { 'x-forwarded-for': '198.51.100.44' } }),
    );

    expect(blocked, 'no address means the rule cannot match one').toBeNull();
    expect(detections).toEqual([]);
    p.stop();
  });
});

describe('the engine derives no address of its own', () => {
  it('resolves nothing when a caller supplies no resolved address', () => {
    // Reached directly rather than through a guard, because every guard sets an explicit `ip` — so this
    // is the only level at which a fallback inside the engine is observable. A socket on the request is
    // not the engine's to consult: the resolution is the caller's job, and an engine that reached for the
    // socket would answer differently from the consumer that resolved properly.
    const engine = new RuleEngine({
      firewall: [
        {
          id: 'any-ip',
          title: 'matches any address at all',
          rule_v2: [{ parameter: 'server.ip', match: { type: 'regex', value: '/.+/' } }],
        },
      ],
      whitelists: [],
      whitelist_keys: {},
    });

    const withSocketOnly: any = {
      method: 'GET',
      url: '/x',
      headers: {},
      query: {},
      body: {},
      socket: { remoteAddress: '203.0.113.9' },
    };

    expect(engine.evaluate(withSocketOnly).blocked, 'the socket is not an address the engine may read')
      .toBe(false);

    // And the positive control: an explicit resolved address is read.
    expect(engine.evaluate({ ...withSocketOnly, ip: '203.0.113.9' }).blocked).toBe(true);
  });
});
