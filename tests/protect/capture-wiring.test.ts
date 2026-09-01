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
    expect(Object.keys(event.capture).sort()).toEqual(
      ['failed', 'omitted', 'plan', 'raw', 'unavailable', 'unsupported', 'values'].sort(),
    );
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
