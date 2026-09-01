import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RuleEngine } from '../../src/protect/engine/engine.js';
import { createNodeMiddleware } from '../../src/protect/engine/node.js';
import { normalizeRequest } from '../../src/protect/engine/normalizer.js';
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
/**
 * A fresh ruleset per call.
 *
 * Nested objects are what a callback can reach, so a shared constant would let one test's mutation change
 * the policy a later test enforces — and these tests exist to prove exactly that cannot happen.
 */
const rules = (scope?: { path?: string; method?: string }) => ({
  firewall: [
    {
      id: 'ip-rule',
      title: 'address under test',
      // The rule reads the address, so what the engine resolved is observable in the outcome.
      rule_v2: [{ parameter: 'server.ip', match: { type: 'contains', value: '198.51.100.' } }],
      // Scope on request, because it is policy in a second nested object: a view that isolated `rule_v2`
      // and shared `when` would still let a callback change which requests the rule applies to. Only the
      // tests that send a matching request ask for it.
      ...(scope ? { when: scope } : {}),
    },
  ],
  whitelists: [],
  whitelist_keys: {},
});

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
      rules: rules(),
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
      rules: rules(),
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
      : rules();
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
    // Resolutions are counted by trapping reads of the policy object. Policy parsing happens on every
    // resolution, including a path with no transport peer where no address is ever established, so the
    // count holds wherever this runs.
    let policyReads = 0;
    const trustedProxy = new Proxy(
      { isTrusted: (ip: string) => ip.startsWith('10.') },
      {
        ownKeys(target) {
          policyReads++;

          return Reflect.ownKeys(target);
        },
      },
    );

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
      trustedProxy,
      onDetect: (d: any) => detections.push(d),
    });

    const readsAfterBoot = policyReads;
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
    // Exactly one resolution for the request, and none added by the response phase.
    expect(policyReads - readsAfterBoot, 'the response phase did not resolve again').toBe(1);
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

describe('the Express view carries evidence a reconstructed body cannot', () => {
  it('keeps the verbatim body for a raw rule', async () => {
    // A body that did not parse leaves the parsed body empty, so a raw view reconstructed from it carries
    // nothing. The verbatim text is the only place the payload survives — which is what a raw rule is
    // for, and a body declared as JSON that is not JSON is an ordinary way to arrive there.
    const p: any = await createProtection({
      rules: {
        firewall: [
          {
            id: 'raw-proto',
            title: 'reads the verbatim body',
            rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '__proto__' } }],
          },
        ],
        whitelists: [],
        whitelist_keys: {},
      },
      mode: 'block',
    });

    const rawBody = 'not-json __proto__ {{payload}}';
    const req = expressReq({
      headers: { 'content-type': 'application/json' },
      // What a parser leaves behind when the body is not the type it claims to be.
      body: {},
      _rawBody: rawBody,
    });

    expect(JSON.stringify(req.body), 'the parsed body carries no evidence at all').not.toContain(
      '__proto__',
    );
    expect(await throughExpress(p, req), 'the raw rule reads the verbatim body').toBe(403);
    p.stop();
  });

  it('refuses raw evidence that only the prototype chain supplies', async () => {
    // Evidence is what THIS request carried. A `_rawBody` reachable through a polluted prototype was
    // carried by nothing, and accepting it would let one pollution fire every raw rule that matches it —
    // arriving as verbatim bytes, indistinguishable from a real body.
    //
    // The test above is the positive control: the same rule, the same payload, as an own property.
    const p: any = await createProtection({
      rules: {
        firewall: [
          {
            id: 'raw-proto',
            title: 'reads the verbatim body',
            rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '__proto__' } }],
          },
        ],
        whitelists: [],
        whitelist_keys: {},
      },
      mode: 'block',
    });

    (Object.prototype as any)._rawBody = 'not-json __proto__ {{payload}}';
    try {
      const req = expressReq({ headers: { 'content-type': 'application/json' }, body: {} });

      expect(Object.hasOwn(req, '_rawBody'), 'the request carries no raw body of its own').toBe(false);
      expect((req as any)._rawBody, 'but the chain offers one').toContain('__proto__');
      expect(await throughExpress(p, req), 'the inherited value is not evidence').toBeNull();

      // The engine's own funnel, which every runtime path goes through, holds the same line.
      const normalized = normalizeRequest({ body: {}, query: {}, headers: {}, url: '/' } as never);
      expect(normalized._rawBody, 'the reconstruction, not the inherited text').not.toContain(
        '__proto__',
      );
    } finally {
      delete (Object.prototype as any)._rawBody;
    }
    p.stop();
  });
});

describe('request evidence comes from the request, not from a polluted prototype', () => {
  const bodyRules = {
    firewall: [
      {
        id: 'raw-marker',
        title: 'reads the verbatim body',
        rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: 'inherited-evidence' } }],
      },
      {
        id: 'post-marker',
        title: 'reads a named field',
        rule_v2: [{ parameter: 'post.marker', match: { type: 'contains', value: 'inherited-evidence' } }],
      },
      {
        id: 'get-marker',
        title: 'reads a query parameter',
        rule_v2: [{ parameter: 'get.marker', match: { type: 'contains', value: 'inherited-evidence' } }],
      },
    ],
    whitelists: [],
    whitelist_keys: {},
  };

  it('fires on a body the request actually carried', async () => {
    // The positive control for the two tests below: the same rules, the same payload, carried for real.
    const p: any = await createProtection({ rules: bodyRules, mode: 'block' });

    expect(
      await throughExpress(p, expressReq({ body: { marker: 'inherited-evidence' } })),
      'an own body is evidence',
    ).toBe(403);
    expect(
      await throughExpress(p, expressReq({ query: { marker: 'inherited-evidence' } })),
      'an own query is evidence',
    ).toBe(403);
    p.stop();
  });

  it('refuses a body only the prototype chain supplies', async () => {
    // Gating `_rawBody` alone is not enough: the raw view falls back to serialising the PARSED body, so a
    // polluted `body` becomes verbatim evidence by that route and fires `raw` and `post.` rules alike.
    const p: any = await createProtection({ rules: bodyRules, mode: 'block' });

    (Object.prototype as any).body = { marker: 'inherited-evidence' };
    try {
      const req = expressReq();
      delete (req as any).body;

      expect(Object.hasOwn(req, 'body'), 'the request carries no body of its own').toBe(false);
      expect((req as any).body, 'but the chain offers one').toEqual({ marker: 'inherited-evidence' });
      expect(await throughExpress(p, req), 'neither a raw nor a post rule sees it').toBeNull();

      // At the engine's own funnel too, where the serialisation happens.
      const normalized = normalizeRequest({ query: {}, headers: {}, url: '/' } as never);
      expect(normalized._rawBody, 'nothing was serialised into raw evidence').not.toContain(
        'inherited-evidence',
      );
      expect(JSON.stringify(normalized.body), 'and nothing became POST data').not.toContain(
        'inherited-evidence',
      );
    } finally {
      delete (Object.prototype as any).body;
    }
    p.stop();
  });

  it('refuses a query string only the prototype chain supplies', async () => {
    const p: any = await createProtection({ rules: bodyRules, mode: 'block' });

    (Object.prototype as any).query = { marker: 'inherited-evidence' };
    try {
      const req = expressReq();
      delete (req as any).query;

      expect((req as any).query, 'the chain offers a query').toEqual({ marker: 'inherited-evidence' });
      expect(await throughExpress(p, req), 'a get rule does not see it').toBeNull();
    } finally {
      delete (Object.prototype as any).query;
    }
    p.stop();
  });

  it('ignores every polluted field at the engine funnel, not just the body', async () => {
    // Each field needs its own check here. The Express projection strips these before the funnel sees
    // them, so a gate removed at the funnel would still look covered by the tests above while every
    // non-Express path went through ungated.
    const MARKER = 'inherited-evidence';
    for (const field of ['body', 'query', 'headers', 'url', 'originalUrl', '_rawBody'] as const) {
      const polluted = field === 'url' || field === 'originalUrl' || field === '_rawBody'
        ? `/x?p=${MARKER}`
        : { marker: MARKER };
      (Object.prototype as any)[field] = polluted;
      try {
        const normalized = normalizeRequest({} as never);

        expect(JSON.stringify(normalized), `${field} did not become evidence`).not.toContain(MARKER);
      } finally {
        delete (Object.prototype as any)[field];
      }
    }

    // The positive control: the same fields, carried by the request, all arrive.
    const normalized = normalizeRequest({
      body: { marker: MARKER },
      query: { marker: MARKER },
      headers: { 'x-marker': MARKER },
      url: `/x?p=${MARKER}`,
    } as never);

    for (const key of ['body', 'query', 'headers', 'url'] as const) {
      expect(JSON.stringify(normalized[key]), `an own ${key} is evidence`).toContain(MARKER);
    }
  });

  /** A request whose named fields come from a prototype, the way `req` really reaches an Express guard. */
  const inheriting = (proto: object, own: Record<string, unknown> = {}) => {
    const req: any = Object.create(proto);
    Object.assign(req, {
      method: 'POST',
      url: '/upload',
      originalUrl: '/upload',
      cookies: {},
      files: {},
      socket: { remoteAddress: '203.0.113.5' },
      readableEnded: true,
      ...own,
    });

    return req;
  };

  it('still screens headers a framework supplies through an inherited getter', async () => {
    // `headers` is a getter on `IncomingMessage.prototype`, so requiring an own property here would leave
    // real requests unscreened on the source rules read most.
    const p: any = await createProtection({
      rules: {
        firewall: [
          {
            id: 'ua-rule',
            title: 'reads a request header',
            rule_v2: [
              {
                parameter: 'server.HTTP_USER_AGENT',
                match: { type: 'contains', value: 'scanner-payload' },
              },
            ],
          },
        ],
        whitelists: [],
        whitelist_keys: {},
      },
      mode: 'block',
    });

    const req = inheriting(
      {
        get headers() {
          return { 'user-agent': 'scanner-payload', 'content-type': 'application/json' };
        },
      },
      { query: {}, body: {} },
    );

    expect(Object.hasOwn(req, 'headers'), 'the headers are inherited, as they really are').toBe(false);
    expect(await throughExpress(p, req), 'a header rule still screens them').toBe(403);
    p.stop();
  });

  it('still screens a query string Express supplies through an inherited getter', async () => {
    // Express defines `query` on its request prototype, so this needs its own test: a failure on the
    // header case above would otherwise hide a query string that stopped being screened.
    const p: any = await createProtection({ rules: bodyRules, mode: 'block' });

    const req = inheriting(
      {
        get query() {
          return { marker: 'inherited-evidence' };
        },
      },
      { headers: { 'content-type': 'application/json' }, body: {} },
    );

    expect(Object.hasOwn(req, 'query'), 'the query is inherited, as Express supplies it').toBe(false);
    expect(await throughExpress(p, req), 'a get rule still screens it').toBe(403);
    p.stop();
  });

  it('refuses a value parked on an intermediate prototype, accessor or not', async () => {
    // The inverse control. `Object.prototype` is not the only writable prototype, so refusing only that
    // one would accept anything installed closer to the request — which is a value the request did not
    // carry, arriving as evidence. A framework supplies request data as an own property or a getter; a
    // data property on a prototype is neither.
    const p: any = await createProtection({ rules: bodyRules, mode: 'block' });

    const req = inheriting({
      body: { marker: 'inherited-evidence' },
      query: { marker: 'inherited-evidence' },
      headers: { 'content-type': 'application/json', 'x-marker': 'inherited-evidence' },
    });

    expect((req as any).body, 'the chain does offer a body').toEqual({ marker: 'inherited-evidence' });
    expect(await throughExpress(p, req), 'no rule sees any of it').toBeNull();

    // And at the funnel, for each field: an inherited data property is refused even where an inherited
    // getter would be honoured.
    const normalized = normalizeRequest(
      Object.create({
        body: { marker: 'inherited-evidence' },
        query: { marker: 'inherited-evidence' },
        headers: { 'x-marker': 'inherited-evidence' },
        url: '/x?p=inherited-evidence',
      }) as never,
    );

    expect(JSON.stringify(normalized), 'nothing inherited became evidence').not.toContain(
      'inherited-evidence',
    );
    p.stop();
  });

  it('refuses an accessor installed on Object.prototype, even for an allowed field', async () => {
    // The inherited-accessor exception must not extend to `Object.prototype`. Pollution can define a
    // GETTER there, not only a value, and that would otherwise arrive through the one door left open —
    // for `headers` and `query`, the two fields the exception exists for.
    const p: any = await createProtection({ rules: bodyRules, mode: 'block' });

    for (const field of ['query', 'headers'] as const) {
      Object.defineProperty(Object.prototype, field, {
        get() {
          return field === 'headers'
            ? { 'content-type': 'application/json', 'x-marker': 'inherited-evidence' }
            : { marker: 'inherited-evidence' };
        },
        configurable: true,
      });
      try {
        const req: any = inheriting({}, { body: {} });
        delete req[field];

        expect(Object.hasOwn(req, field), `the request has no own ${field}`).toBe(false);
        expect((req as any)[field], 'the polluted accessor does supply one').toBeTruthy();
        expect(await throughExpress(p, req), `a rule reading ${field} does not see it`).toBeNull();

        const normalized = normalizeRequest({} as never);

        expect(JSON.stringify(normalized), `${field} did not become evidence`).not.toContain(
          'inherited-evidence',
        );
      } finally {
        delete (Object.prototype as any)[field];
      }
    }
    p.stop();
  });

  it('refuses an inherited getter for a field no framework supplies that way', async () => {
    // The exception is per field, not general: a getter installed for `body` is not how any supported
    // framework delivers a parsed body, so it is refused like any other inherited value.
    const p: any = await createProtection({ rules: bodyRules, mode: 'block' });

    const req = inheriting(
      {
        get body() {
          return { marker: 'inherited-evidence' };
        },
      },
      { headers: { 'content-type': 'application/json' }, query: {} },
    );

    expect((req as any).body, 'the getter does supply one').toEqual({
      marker: 'inherited-evidence',
    });
    expect(await throughExpress(p, req), 'a raw or post rule does not see it').toBeNull();
    p.stop();
  });
});

describe('a host callback cannot rewrite what the platform is told', () => {
  /**
   * One blocked request through a guard whose `onDetect` rewrites everything it can reach, returning what
   * each internal reporter transported.
   *
   * Both reporters are captured, and each is asserted in its own test. Asserting both inside one test
   * would hide the second set behind the first failure, so a change affecting only the block log would
   * read as covered while never having been checked.
   */
  const hostileRun = async () => {
    const bodies: any[] = [];
    const logged: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/detections/')) bodies.push(JSON.parse(String(init?.body ?? '{}')));
      if (target.includes('/api/logs/log')) {
        const form = new URLSearchParams(String(init?.body ?? ''));
        logged.push(...JSON.parse(form.get('logs') ?? '[]'));
      }
      if (target.includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt-abc', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ ...rules(), enforcement: 'block' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"v1"' },
      });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: 'the-secret-40-chars-long-ish-value-here-987',
      apiKey: 'secret0000000000000000000000000000000000-12345',
      detectionFlushMs: 1,
      fetchImpl,
      onDetect: (d: any) => {
        // A callback doing the worst thing it can reach.
        d.ip = '203.0.113.250';
        d.clientIpSource = 'trusted-proxy';
        d.path = '/somewhere-else';
        if (d.rule) d.rule.id = 'not-the-rule-that-fired';
      },
    });

    await throughExpress(
      p,
      expressReq({
        method: 'GET',
        url: '/api',
        originalUrl: '/api',
        headers: {},
        socket: { remoteAddress: '198.51.100.7' },
      }),
    );
    p.stop();
    await new Promise((r) => setTimeout(r, 15));

    return { events: bodies.flatMap((b) => b.detections ?? []), logged };
  };

  it('reports the detection the engine produced, not the one the callback substituted', async () => {
    const { events } = await hostileRun();

    expect(events.length, 'a detection was reported').toBeGreaterThan(0);
    expect(events[0].client_ip, 'the engine’s address was transported').toBe('198.51.100.7');
    expect(events[0].client_ip_source).toBe('runtime');
    expect(events[0].rule_id, 'the rule that actually fired').toBe('ip-rule');
    expect(events[0].route).toBe('/api');
  });

  it('logs the block the engine produced, not the one the callback substituted', async () => {
    // The block log builds its own record from the same detection, so it needs its own assertion: the
    // reporters share no code, and a defence that held for one is not evidence about the other.
    const { logged } = await hostileRun();

    expect(logged.length, 'a block record was posted').toBeGreaterThan(0);
    expect(logged[0].ip, 'the engine’s address reached the block log').toBe('198.51.100.7');
    expect(logged[0].fid, 'the rule that actually fired').toBe('ip-rule');
    expect(logged[0].request_uri).toBe('/api');
  });

  it('hands the callback the rule identity only, whatever the rule carries', async () => {
    // The contract for `rule` is `{ id, category }`, and narrowing to it is what keeps policy out of a
    // callback's reach. The rule here also carries something no structured clone accepts, because this
    // path runs on every detection and must not depend on a rule being copyable.
    const seen: any[] = [];
    const p: any = await createProtection({
      rules: { ...rules(), firewall: rules().firewall.map((r) => ({ ...r, onSomething: () => {} })) },
      mode: 'block',
      onDetect: (d: any) => {
        seen.push(d.rule);
        if (d.rule?.rule_v2?.[0]?.match) d.rule.rule_v2[0].match.value = 'never-matches-anything';
      },
    });

    const req = () =>
      expressReq({
        method: 'GET',
        url: '/api',
        originalUrl: '/api',
        headers: {},
        socket: { remoteAddress: '198.51.100.7' },
      });

    expect(await throughExpress(p, req()), 'the rule still blocks').toBe(403);
    expect(seen.length, 'the callback still ran').toBeGreaterThan(0);
    expect(seen[0].id, 'the rule is still identified').toBe('ip-rule');
    // Exactly the promised fields, so nothing carrying policy went out.
    expect(Object.keys(seen[0]).sort()).toEqual(['category', 'id']);
    expect(await throughExpress(p, req()), 'the policy survived').toBe(403);
    p.stop();
  });

  it('does not let a callback edit the running ruleset', async () => {
    // The interesting parts of a rule are nested — `rule_v2`, and the match objects inside it — so a
    // shallow copy would still share them. This mutates a match value through the callback and then sends
    // a second request through the SAME guard: if the clone were shallow, the guard would now be
    // screening for something the callback chose.
    const seen: any[] = [];
    const p: any = await createProtection({
      rules: rules({ path: '/api', method: 'GET' }),
      mode: 'block',
      onDetect: (d: any) => {
        seen.push(d.rule);
        if (d.rule?.rule_v2?.[0]?.match) d.rule.rule_v2[0].match.value = 'never-matches-anything';
        if (d.rule?.when) d.rule.when.method = 'OPTIONS';
        if (d.rule) d.rule.id = 'rewritten';
      },
    });

    const req = () =>
      expressReq({
        method: 'GET',
        url: '/api',
        originalUrl: '/api',
        headers: {},
        socket: { remoteAddress: '198.51.100.7' },
      });

    expect(await throughExpress(p, req()), 'the rule matches on the first request').toBe(403);
    // Same guard, same request: the policy is unchanged, so it still matches.
    expect(await throughExpress(p, req()), 'the policy survived the callback').toBe(403);
    // Neither nested policy object was ever within reach.
    expect(seen[0].rule_v2, 'no match policy was handed out').toBeUndefined();
    expect(seen[0].when, 'no scope was handed out').toBeUndefined();
    p.stop();
  });
});

describe('stopping a guard waits for every buffer it reaches', () => {
  it('waits for the block log, not only for the detection reporter', async () => {
    // `stop()` promises that the buffers it reaches are finished with. Waiting for one reporter would
    // resolve while the other still had records outstanding — and resolve at once in a configuration
    // where the awaited one was never built.
    let releaseLog: ((r: Response) => void) | null = null;
    let logPosted = false;
    const fetchImpl = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt-abc', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/api/logs/log')) {
        logPosted = true;

        return new Promise<Response>((resolve) => { releaseLog = resolve; });
      }

      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const p: any = await createProtection({
      rules: rules(),
      mode: 'block',
      // A block-log reporter and no detection reporter: no site uuid, so the detection path is a no-op
      // and the block log is the only buffer with anything outstanding.
      apiKey: 'secret0000000000000000000000000000000000-12345',
      fetchImpl,
    });

    await throughExpress(
      p,
      expressReq({
        method: 'GET',
        url: '/api',
        originalUrl: '/api',
        headers: {},
        socket: { remoteAddress: '198.51.100.7' },
      }),
    );

    let settled = false;
    const done = p.stop().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));

    expect(logPosted, 'the block log is in flight').toBe(true);
    expect(settled, 'and the wait has not finished with it').toBe(false);

    releaseLog?.(new Response('{}', { status: 200 }));
    await done;
    expect(settled).toBe(true);
  });
});
