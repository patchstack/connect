import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RuleEngine } from '../../src/protect/engine/engine.js';
import { createNodeMiddleware } from '../../src/protect/engine/node.js';
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

/** Drive an Express-style request through `.express()` and report whether it was blocked. */
async function throughExpress(p: any, req: any) {
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

  return status;
}

const expressReq = (over: Record<string, unknown> = {}) => ({
  method: 'POST',
  url: '/upload',
  originalUrl: '/upload',
  headers: { 'content-type': 'multipart/form-data' },
  query: {},
  body: {},
  cookies: {},
  files: {},
  socket: { remoteAddress: '203.0.113.5' },
  readableEnded: true,
  ...over,
});

describe('the Express view carries everything a rule can address', () => {
  it('keeps the method, so a method-scoped rule still applies', async () => {
    // The engine normalises with a spread, which copies own properties only — so a view that left the
    // application's fields inherited would arrive carrying almost nothing, and a scoped rule would
    // silently match no traffic at all.
    const p: any = await createProtection({
      rules: {
        firewall: [
          {
            id: 'post-only',
            title: 'scoped to POST',
            when: { method: 'POST' },
            rule_v2: [{ parameter: 'server.REQUEST_METHOD', match: { type: 'contains', value: 'POST' } }],
          },
        ],
        whitelists: [],
        whitelist_keys: {},
      },
      mode: 'block',
    });

    expect(await throughExpress(p, expressReq()), 'a POST-scoped rule sees the method').toBe(403);
    p.stop();
  });

  it('keeps uploaded file metadata', async () => {
    const p: any = await createProtection({
      rules: {
        firewall: [
          {
            id: 'file-rule',
            title: 'reads an uploaded file name',
            rule_v2: [{ parameter: 'files.avatar', match: { type: 'contains', value: 'payload.php' } }],
          },
        ],
        whitelists: [],
        whitelist_keys: {},
      },
      mode: 'block',
    });

    const req = expressReq({ files: { avatar: { filename: 'payload.php', type: 'text/php', content: '' } } });
    expect(await throughExpress(p, req), 'a files rule sees the upload').toBe(403);
    p.stop();
  });

  it('keeps parsed cookies', async () => {
    const p: any = await createProtection({
      rules: {
        firewall: [
          {
            id: 'cookie-rule',
            title: 'reads a parsed cookie',
            rule_v2: [{ parameter: 'cookie.session', match: { type: 'contains', value: 'tampered' } }],
          },
        ],
        whitelists: [],
        whitelist_keys: {},
      },
      mode: 'block',
    });

    const req = expressReq({ cookies: { session: 'tampered-value' } });
    expect(await throughExpress(p, req), 'a cookie rule sees the parsed cookie').toBe(403);
    p.stop();
  });
});

describe('the transported detection carries the address', () => {
  /** Capture the serialized detections request body for one request. */
  async function capture(opts: {
    trustedProxy?: unknown;
    req?: any;
    fetchReq?: Request;
    ruleOverride?: Record<string, unknown>;
  }) {
    const served = opts.ruleOverride
      ? { firewall: [opts.ruleOverride], whitelists: [], whitelist_keys: {} }
      : RULES;
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('token')) {
        return new Response(JSON.stringify({ access_token: 'jwt-abc', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/detections/')) bodies.push(JSON.parse(String(init?.body ?? '{}')));

      return new Response(JSON.stringify({ ...served, enforcement: 'block' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"v1"' },
      });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: 'the-secret-40-chars-long-ish-value-here-987',
      detectionFlushMs: 1,
      trustedProxy: opts.trustedProxy,
      fetchImpl,
    });

    if (opts.fetchReq) await p.fetchGuard()(opts.fetchReq);
    else await throughExpress(p, opts.req);

    p.stop();
    await new Promise((r) => setTimeout(r, 15));

    return bodies.flatMap((b) => b.detections ?? []).filter((d: any) => d.rule_id === 'ip-rule');
  }

  it('sends the address and its provenance for a trusted proxy', async () => {
    const events = await capture({
      trustedProxy: { peers: ['10.0.0.0/8'] },
      req: expressReq({
        method: 'GET',
        url: '/api',
        originalUrl: '/api',
        headers: { 'x-forwarded-for': '198.51.100.44, 10.0.0.3' },
        socket: { remoteAddress: '10.0.0.7' },
      }),
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].client_ip).toBe('198.51.100.44');
    expect(events[0].client_ip_source).toBe('trusted-proxy');
  });

  it('sends the observed peer when there is no policy', async () => {
    const events = await capture({
      req: expressReq({
        method: 'GET',
        url: '/api',
        originalUrl: '/api',
        headers: { 'x-forwarded-for': '9.9.9.9' },
        socket: { remoteAddress: '198.51.100.7' },
      }),
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].client_ip).toBe('198.51.100.7');
    expect(events[0].client_ip_source).toBe('runtime');
  });

  it('omits the address entirely when none could be established', async () => {
    // A Fetch runtime has no transport peer. The provenance still travels, because "this could not be
    // established" is what a reader needs — but no field claims an address.
    const events = await capture({
      trustedProxy: { peers: ['10.0.0.0/8'] },
      // A rule that fires on the query rather than the address: with no address to match, an
      // address-reading rule would produce no detection at all and there would be nothing to inspect.
      ruleOverride: {
        id: 'ip-rule',
        title: 'fires regardless of the address',
        rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }],
      },
      fetchReq: new Request('https://app.test/api?q=boom', {
        headers: { 'x-forwarded-for': '198.51.100.44' },
      }),
    });

    expect(events.length).toBeGreaterThan(0);
    expect(Object.hasOwn(events[0], 'client_ip'), 'no field claims an address').toBe(false);
    expect(events[0].client_ip_source).toBe('unavailable');
  });
});

describe('the response phase reuses the request phase resolution', () => {
  it('gives a response rule the same address, without resolving again', async () => {
    const detections: any[] = [];
    const seen: string[] = [];
    const isTrusted = vi.fn((ip: string) => {
      seen.push(ip);

      return ip.startsWith('10.');
    });

    const p: any = await createProtection({
      // A response rule that reads the address the request phase resolved.
      rules: {
        firewall: [
          {
            id: 'resp-ip',
            title: 'response rule reading the client address',
            phase: 'response',
            action: 'block',
            rule_v2: [{ parameter: 'server.ip', match: { type: 'contains', value: '198.51.100.' } }],
          },
        ],
        whitelists: [],
        whitelist_keys: {},
      },
      mode: 'block',
      trustedProxy: { isTrusted },
      onDetect: (d: any) => detections.push(d),
    });

    const handler = async () => new Response('body', { status: 200, headers: { 'content-type': 'text/plain' } });
    const res = await p.fetch(handler)(
      new Request('https://app.test/api', {
        headers: { 'x-forwarded-for': '198.51.100.44, 10.0.0.3' },
      }),
    );

    // A Fetch runtime has no peer, so no address is established and the response rule cannot match on
    // one — which is the same answer the request phase reached. The point is that they agree.
    expect(res.status).toBe(200);
    const response = detections.filter((d) => d.phase === 'response');
    expect(response, 'the response phase saw no address either').toEqual([]);
    // And the resolution happened at most once for the request: the response phase did not repeat it.
    expect(seen.length, 'no second resolution for the response').toBe(0);
    p.stop();
  });

  it('carries an established address into a response detection', async () => {
    // The Node path has a transport peer, so an address exists — and the response detection names the
    // same one the request phase resolved.
    const detections: any[] = [];
    const p: any = await createProtection({
      rules: {
        firewall: [
          {
            id: 'resp-ip',
            title: 'response rule reading the client address',
            phase: 'response',
            action: 'block',
            rule_v2: [{ parameter: 'server.ip', match: { type: 'contains', value: '198.51.100.' } }],
          },
        ],
        whitelists: [],
        whitelist_keys: {},
      },
      mode: 'block',
      onDetect: (d: any) => detections.push(d),
    });

    const req = expressReq({
      method: 'GET',
      url: '/api',
      originalUrl: '/api',
      headers: {},
      socket: { remoteAddress: '198.51.100.7' },
    });

    // `.express({ screenResponses: true })` wraps the response, so the response phase runs against the
    // originating request's own resolution.
    const chunks: string[] = [];
    const res: any = {
      statusCode: 200,
      setHeader() {}, getHeader() { return 'text/plain'; }, removeHeader() {},
      writeHead() { return this; },
      write(c: string) { chunks.push(String(c)); return true; },
      end(c?: string) { if (c) chunks.push(String(c)); return this; },
      status() { return this; }, json() { return this; }, send() { return this; }, type() { return this; },
    };

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      p.express({ screenResponses: true })(req, res, () => { res.end('body'); finish(); });
      setTimeout(finish, 30);
    });

    const response = detections.filter((d) => d.phase === 'response');
    expect(response.length, 'the response rule matched the resolved address').toBeGreaterThan(0);
    expect(response[0].ip).toBe('198.51.100.7');
    expect(response[0].clientIpSource).toBe('runtime');
    p.stop();
  });
});

describe('the standalone Node adapter honours its own configuration', () => {
  it('applies a trusted-proxy policy its caller declared', async () => {
    const blocked: any[] = [];
    // The adapter shapes the request itself, so a policy that reached `createProtection` but not this
    // path would leave the adapter reporting the socket peer while its caller believed a front end was
    // declared — a difference nothing in the output would reveal.
    const guard = createNodeMiddleware(
      {
        firewall: [
          {
            id: 'ip-rule',
            title: 'reads the client address',
            rule_v2: [{ parameter: 'server.ip', match: { type: 'contains', value: '198.51.100.' } }],
          },
        ],
        whitelists: [],
        whitelist_keys: {},
      },
      { trustedProxy: { peers: ['10.0.0.0/8'] }, onBlock: (b: any) => blocked.push(b) },
    );

    const req: any = new EventEmitter();
    Object.assign(req, {
      method: 'GET',
      url: '/api',
      headers: { host: 'app.test', 'x-forwarded-for': '198.51.100.44, 10.0.0.3' },
      socket: { remoteAddress: '10.0.0.7' },
    });

    let status: number | null = null;
    const res: any = {
      statusCode: 200,
      setHeader() {}, getHeader() {}, removeHeader() {},
      writeHead(code: number) { status = code; return this; },
      end() { return this; },
    };

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      guard(req, res, finish);
      req.emit('end');
      setTimeout(finish, 30);
    });

    // The adapter's own block record carries the address it used, which is the discriminating fact.
    expect(blocked.length, 'the declared policy reached the adapter').toBe(1);
    expect(blocked[0].request.ip).toBe('198.51.100.44');
  });

  it('reports the socket peer when its caller declared no policy', async () => {
    const blocked: any[] = [];
    // The positive control: an adapter that ignored the policy entirely would also pass the case above if
    // the peer happened to match, so the no-policy answer has to differ.
    const guard = createNodeMiddleware(
      {
        firewall: [
          {
            id: 'ip-rule',
            title: 'reads the client address',
            rule_v2: [{ parameter: 'server.ip', match: { type: 'contains', value: '198.51.100.' } }],
          },
        ],
        whitelists: [],
        whitelist_keys: {},
      },
      { onBlock: (b: any) => blocked.push(b) },
    );

    const req: any = new EventEmitter();
    Object.assign(req, {
      method: 'GET',
      url: '/api',
      headers: { host: 'app.test', 'x-forwarded-for': '198.51.100.44, 10.0.0.3' },
      socket: { remoteAddress: '10.0.0.7' },
    });

    let status: number | null = null;
    const res: any = {
      statusCode: 200,
      setHeader() {}, getHeader() {}, removeHeader() {},
      writeHead(code: number) { status = code; return this; },
      end() { return this; },
    };

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      guard(req, res, finish);
      req.emit('end');
      setTimeout(finish, 30);
    });

    expect(blocked, 'without a policy the forwarded header is not read').toEqual([]);
  });
});
