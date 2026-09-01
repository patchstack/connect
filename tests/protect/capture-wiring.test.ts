import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * Evidence reaching an event, and nothing else reaching anyone.
 *
 * The plan decides what may be captured and the extractor bounds it; both are tested on their own. What
 * these assert is the seam: that the bounded result travels on the event, that the resolver it came from
 * does not travel at all, and that a rule permitting nothing produces an event saying so rather than an
 * event that looks like a failure.
 */
const AUTH = 'the-secret-40-chars-long-ish-value-here-987';

/**
 * A platform that serves the ruleset and records what is posted back.
 *
 * The rules arrive from the API on purpose: reporting is gated on a site running the platform's own
 * rules, so a bundle passed in directly is not enrolled and produces no events at all.
 */
function stub(served: unknown) {
  const bodies: any[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('token')) {
      return new Response(JSON.stringify({ access_token: 'jwt', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (target.includes('/detections/')) {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));

      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ ...(served as object), enforcement: 'block' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: '"v1"' },
    });
  });

  return { bodies, impl };
}

const guardFor = async (impl: unknown, over: Record<string, unknown> = {}) => {
  vi.stubGlobal('fetch', impl);

  return (await createProtection({
    siteUuid: 'site-1',
    pulseRulesUrl: 'https://x.test/monitor/pulse',
    pulseAuth: AUTH,
    detectionFlushMs: 1,
    mode: 'block',
    fetchImpl: impl as typeof fetch,
    ...over,
  })) as any;
};

const expressReq = (over: Record<string, unknown> = {}) => ({
  method: 'POST',
  url: '/checkout',
  originalUrl: '/checkout',
  headers: { 'content-type': 'application/json' },
  query: {},
  body: {},
  cookies: {},
  files: {},
  socket: { remoteAddress: '198.51.100.7' },
  readableEnded: true,
  ...over,
});

async function through(p: any, req: any) {
  const res: any = {
    statusCode: 200,
    setHeader() {}, getHeader() {}, removeHeader() {},
    status() { return this; }, type() { return this; },
    send() { return this; }, json() { return this; }, end() { return this; },
  };
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    p.express()(req, res, finish);
    setTimeout(finish, 30);
  });
  p.stop();
  await new Promise((r) => setTimeout(r, 20));
}

const eventsFrom = (bodies: any[]) => bodies.flatMap((b) => b.detections ?? []);

const ruleReading = (parameters: string[], extra: Record<string, unknown> = {}) => ({
  firewall: [
    {
      id: 'r1',
      title: 'a rule under test',
      rule_v2: parameters.map((parameter) => ({ parameter, match: { type: 'contains', value: 'boom' } })),
      ...extra,
    },
  ],
  whitelists: [],
  whitelist_keys: {},
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a detection carries the evidence its rule permitted', () => {
  it('sends the value of a parameter the rule names', async () => {
    const { bodies, impl } = stub(ruleReading(['post.title']));
    const p = await guardFor(impl);
    await through(p, expressReq({ body: { title: 'boom-payload' } }));

    const [event] = eventsFrom(bodies);
    expect(event.capture.plan, 'the policy that permitted it').toMatch(/^cp2-/);
    expect(event.capture.values).toEqual([{ parameter: 'post.title', value: 'boom-payload' }]);
  });

  it('sends no value of a parameter the rule does not name', async () => {
    const { bodies, impl } = stub(ruleReading(['post.title']));
    const p = await guardFor(impl);
    await through(p, expressReq({ body: { title: 'boom', secret: 'SENTINEL-UNNAMED' } }));

    // The plan is the whole control: a field beside the one the rule reads is not evidence for it.
    expect(JSON.stringify(bodies)).not.toContain('SENTINEL-UNNAMED');
  });

  it('says a rule was permitted nothing, rather than saying nothing', async () => {
    const { bodies, impl } = stub(ruleReading(['raw']));
    // `raw` reads the whole request, so it permits nothing without a reviewed opt-in.
    const p = await guardFor(impl);
    await through(p, expressReq({ headers: { 'content-type': 'application/json' }, _rawBody: 'boom-raw' }));

    const [event] = eventsFrom(bodies);
    expect(event.capture.plan, 'the policy is still named').toMatch(/^cp2-/);
    expect(Object.hasOwn(event.capture, 'values'), 'and it permitted nothing').toBe(false);
    expect(JSON.stringify(bodies)).not.toContain('boom-raw');
  });

  it('sends a bounded prefix of the raw body under a reviewed opt-in', async () => {
    const { bodies, impl } = stub(ruleReading(['raw'], { capture: { version: 1, raw_chars: 16 } }));
    const p = await guardFor(impl);
    const raw = 'boom-' + 'z'.repeat(400);
    await through(p, expressReq({ headers: { 'content-type': 'application/json' }, _rawBody: raw }));

    const [event] = eventsFrom(bodies);
    expect(event.capture.raw.value.length).toBe(16);
    expect(event.capture.raw.truncated).toBe(true);
  });

  it('never sends the resolver, or anything that could read the request again', async () => {
    const { bodies, impl } = stub(ruleReading(['post.title']));
    const p = await guardFor(impl);
    await through(p, expressReq({ body: { title: 'boom', other: 'SENTINEL-UNREAD' } }));

    const posted = JSON.stringify(bodies);
    // Everything a resolver would carry: the request it holds, and the fields beside the named one.
    expect(posted).not.toContain('SENTINEL-UNREAD');
    expect(posted).not.toContain('resolver');
    expect(posted).not.toContain('_rawBody');
    const [event] = eventsFrom(bodies);
    // The whole of what evidence may carry: a policy reference, the values it permitted, and counts of
    // what did not make it. A key beyond this list is something nobody documented leaving an app.
    const permitted = new Set([
      'plan',
      'values',
      'raw',
      'omitted',
      'unsupported',
      'failed',
      'unavailable',
      'truncated',
    ]);
    for (const key of Object.keys(event.capture)) {
      expect(permitted.has(key), `capture carries an undocumented "${key}"`).toBe(true);
    }
    expect(Object.keys(event.capture)).toContain('plan');
    expect(Object.keys(event.capture)).toContain('values');
  });
});

describe('what the host callback receives', () => {
  it('does not include the evidence', async () => {
    const { impl } = stub(ruleReading(['post.title']));
    const seen: any[] = [];
    const p = await guardFor(impl, { onDetect: (d: any) => seen.push(d) });
    await through(p, expressReq({ body: { title: 'boom-payload' } }));

    // The documented callback carries the rule's identity and the request's own metadata. A host already
    // holds the request these values came from, so widening the contract to forward evidence is a
    // separate decision rather than a side effect of collecting any.
    expect(seen.length).toBeGreaterThan(0);
    expect(Object.hasOwn(seen[0], 'capture')).toBe(false);
    expect(JSON.stringify(seen)).not.toContain('boom-payload');
  });
});

describe('a guard with reporting off sends nothing, and shows a host nothing', () => {
  it('posts no event and hands the callback no evidence', async () => {
    // Not a test that evidence goes underived: with no reporter there is no event either way, and the
    // callback is stripped by design, so derivation is not observable from outside. Skipping the work is
    // a cost decision. What IS observable, and asserted here, is that nothing leaves.
    const posted: string[] = [];
    const seen: any[] = [];
    const impl = vi.fn(async (url: string) => {
      posted.push(String(url));

      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', impl);

    const p = (await createProtection({
      rules: ruleReading(['post.title']),
      mode: 'block',
      fetchImpl: impl as typeof fetch,
      onDetect: (d: any) => seen.push(d),
    })) as any;
    await through(p, expressReq({ body: { title: 'boom-payload' } }));

    expect(seen.length, 'the rule fired').toBeGreaterThan(0);
    expect(posted.filter((u) => u.includes('/detections/')), 'nothing was reported').toEqual([]);
    expect(JSON.stringify(seen), 'and the host saw no value').not.toContain('boom-payload');
  });
});

describe('capture is the rule\'s union, not the matching condition', () => {
  it('sends a value named by a condition that did not fire', async () => {
    // The engine reports which RULE matched, not which of its conditions did. So a plan covers everything
    // the rule reads — and a reader has to know that, because a rule scoped to one parameter captures one
    // while a broad rule captures what it is broad about.
    const rules = {
      firewall: [
        {
          id: 'r1',
          title: 'two conditions, either of which fires',
          rule_v2: [
            { parameter: 'post.title', match: { type: 'contains', value: 'boom' } },
            { parameter: 'cookie.session', match: { type: 'contains', value: 'never-matches' } },
          ],
        },
      ],
      whitelists: [],
      whitelist_keys: {},
    };
    const { bodies, impl } = stub(rules);
    const p = await guardFor(impl);
    // Only the first condition can fire; the cookie does not contain what its condition looks for.
    await through(
      p,
      expressReq({ body: { title: 'boom-payload' }, cookies: { session: 'quiet-session-value' } }),
    );

    const [event] = eventsFrom(bodies);
    const captured = event.capture.values.map((v: any) => v.parameter).sort();

    expect(captured, 'both parameters the rule reads').toEqual(['cookie.session', 'post.title']);
    expect(JSON.stringify(bodies), 'including the one whose condition did not match').toContain(
      'quiet-session-value',
    );
  });
});

describe('a response detection names its capture policy too', () => {
  const responseRules = (over: Record<string, unknown> = {}) => ({
    firewall: [
      {
        id: 'resp-1',
        title: 'a response rule',
        phase: 'response',
        action: 'block',
        rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'SENTINEL-RESP' } }],
        ...over,
      },
    ],
    whitelists: [],
    whitelist_keys: {},
  });

  async function throughResponse(p: any, req: any, body: string) {
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
      p.express({ screenResponses: true })(req, res, () => { res.end(body); finish(); });
      setTimeout(finish, 30);
    });
    p.stop();
    await new Promise((r) => setTimeout(r, 20));
  }

  it('reports a plan that permitted nothing, rather than no plan', async () => {
    const { bodies, impl } = stub(responseRules());
    const p = await guardFor(impl);
    await throughResponse(p, expressReq({ method: 'GET', url: '/page', originalUrl: '/page' }), 'SENTINEL-RESP body');

    const events = eventsFrom(bodies).filter((e: any) => e.phase === 'response');
    expect(events.length, 'the response rule fired').toBeGreaterThan(0);
    expect(events[0].capture.plan, 'and named its policy').toMatch(/^cp2-/);
    // Response sources are never capturable, whatever a rule names, so there is nothing to permit.
    expect(Object.hasOwn(events[0].capture, 'values')).toBe(false);
  });

  it('never sends a response value, even to a rule written to read one', async () => {
    const { bodies, impl } = stub(responseRules());
    const p = await guardFor(impl);
    await throughResponse(p, expressReq({ method: 'GET', url: '/page', originalUrl: '/page' }), 'SENTINEL-RESP body');

    // The phase that reads these exists to redact secrets; capturing them would collect the very values
    // redaction stops leaving.
    expect(JSON.stringify(bodies)).not.toContain('SENTINEL-RESP');
  });

  it('captures a request parameter a response rule also names', async () => {
    // A response-phase rule can scope on the request, and those sources are capturable — so "response
    // rules capture nothing" would be the wrong generalisation.
    const { bodies, impl } = stub(
      responseRules({
        rule_v2: [
          { parameter: 'response.body', match: { type: 'contains', value: 'SENTINEL-RESP' } },
          { parameter: 'server.HTTP_USER_AGENT', match: { type: 'contains', value: 'never-matches' } },
        ],
      }),
    );
    const p = await guardFor(impl);
    await throughResponse(
      p,
      expressReq({
        method: 'GET',
        url: '/page',
        originalUrl: '/page',
        headers: { 'content-type': 'application/json', 'user-agent': 'SENTINEL-UA' },
      }),
      'SENTINEL-RESP body',
    );

    const events = eventsFrom(bodies).filter((e: any) => e.phase === 'response');
    expect(events[0].capture.values?.map((v: any) => v.parameter)).toEqual(['server.HTTP_USER_AGENT']);
    expect(JSON.stringify(bodies)).toContain('SENTINEL-UA');
  });
});
