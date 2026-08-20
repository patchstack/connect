import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDetectionReporter, routeOf, ruleParameters } from '../../src/protect/detections.js';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * Reporting what a rule WOULD have stopped.
 *
 * The block log answers "what did we stop", in the WordPress-compatible shape. This channel answers the
 * question nothing could answer before: a rule carrying `enforcement: dry-run` saw traffic it would have
 * blocked. Without it, a rule that is quietly wrong looks exactly like one that is protecting.
 *
 * Most of this file is about what the payload must NOT contain. A counting channel that carries matched
 * values is a store of other people's data, and the difference between the two is one careless field.
 */

/** `flush()` posts after awaiting the auth header, so a caller sees the request one tick later. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Everything the payload is allowed to carry, and nothing else. */
const ALLOWED_KEYS = ['rule_id', 'route', 'parameters', 'phase', 'enforced', 'rules_etag', 'detected_at'];

const pinnedRule = {
  id: 'pulse-1',
  rule_v2: [
    { parameter: 'server.REQUEST_URI', inclusive: true, match: { type: 'contains', value: '/api/preview' } },
    { parameter: 'get.url', inclusive: true, match: { type: 'internal_host' } },
  ],
};

function reporterWith(overrides: Record<string, unknown> = {}) {
  const posts: Array<{ url: string; body: any }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });

    return new Response('{}', { status: 202 });
  });
  const reporter = createDetectionReporter({
    siteUuid: 'site-1',
    baseUrl: 'https://x.test/monitor/pulse',
    rulesEtag: '"v7"',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });

  return { reporter, posts, fetchImpl };
}

afterEach(() => vi.restoreAllMocks());

describe('the detection payload', () => {
  it('carries what accounting needs and nothing else', async () => {
    const { reporter, posts } = reporterWith();

    reporter.record({ rule: pinnedRule, phase: 'request', mode: 'dry-run', path: '/api/preview?url=x' });
    reporter.flush();
    await drain();

    const [event] = posts[0].body.detections;
    expect(Object.keys(event).sort()).toEqual([...ALLOWED_KEYS].sort());
    expect(event).toMatchObject({
      rule_id: 'pulse-1',
      route: '/api/preview',
      parameters: ['server.REQUEST_URI', 'get.url'],
      phase: 'request',
      // The point of the channel: this rule did not block, and that is the interesting case.
      enforced: false,
      rules_etag: '"v7"',
    });
    expect(typeof event.detected_at).toBe('string');
  });

  it('never puts a matched value, a query string, a body or a header on the wire', async () => {
    // The load-bearing test, and deliberately a scan of the serialized payload rather than of the object
    // we built: a field added later — `message`, `value`, `headers` — would pass every assertion above
    // and fail here, which is the direction this needs to fail in.
    const { reporter, posts } = reporterWith();

    reporter.record({
      rule: pinnedRule,
      phase: 'request',
      mode: 'block',
      // Everything a real detection has hanging off it. None of it may travel.
      path: '/api/preview?url=http://169.254.169.254/latest/meta-data/&token=SUPER_SECRET',
      method: 'POST',
      ip: '203.0.113.9',
      userAgent: 'curl/8.0',
      message: 'Blocked by Patchstack WAF rule: internal host in get.url',
      value: 'http://169.254.169.254/latest/meta-data/',
    } as never);
    reporter.flush();
    await drain();

    const wire = JSON.stringify(posts[0].body);
    for (const forbidden of ['SUPER_SECRET', '169.254.169.254', 'meta-data', '203.0.113.9', 'curl/8.0', 'Blocked by']) {
      expect(wire, `${forbidden} must not reach the reporting endpoint`).not.toContain(forbidden);
    }
    // And the route survived, so the scan above is not passing because nothing was sent.
    expect(wire).toContain('/api/preview');
  });

  it('reports the enforcement state, not the site mode', async () => {
    const { reporter, posts } = reporterWith();

    reporter.record({ rule: pinnedRule, mode: 'block', path: '/a' });
    reporter.record({ rule: pinnedRule, mode: 'dry-run', path: '/a' });
    reporter.flush();
    await drain();

    expect(posts[0].body.detections.map((d: any) => d.enforced)).toEqual([true, false]);
  });

  it('drops a detection without a rule id rather than sending an anonymous row', () => {
    const { reporter, fetchImpl } = reporterWith();

    reporter.record({ rule: {}, path: '/a' } as never);
    reporter.record({ path: '/a' } as never);
    reporter.flush();

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('bounds and failure', () => {
  it('bounds the queue and says how much it dropped', async () => {
    // A detection storm must cost memory it cannot grow out of. The drop count travels WITH the batch:
    // a consumer computing a rate from these needs to know its denominator is short, and inferring that
    // from a gap is not something anyone does.
    const { reporter, posts } = reporterWith({ maxQueue: 3 });

    for (let i = 0; i < 10; i++) reporter.record({ rule: pinnedRule, mode: 'dry-run', path: `/a/${i}` });
    reporter.flush();
    await drain();

    expect(posts[0].body.detections.length).toBe(3);
    expect(posts[0].body.dropped).toBe(7);
    // The survivors are the newest — a storm's tail is what a reviewer wants, not its head.
    expect(posts[0].body.detections.map((d: any) => d.route)).toEqual(['/a/7', '/a/8', '/a/9']);
  });

  it('is silent and harmless when the endpoint rejects or throws', async () => {
    const rejecting = vi.fn(async () => {
      throw new Error('network down');
    });
    const reporter = createDetectionReporter({
      siteUuid: 'site-1',
      baseUrl: 'https://x.test/monitor/pulse',
      fetchImpl: rejecting as unknown as typeof fetch,
    });

    reporter.record({ rule: pinnedRule, mode: 'block', path: '/a' });
    expect(() => reporter.flush()).not.toThrow();
    await Promise.resolve();
  });

  it('is a no-op without a site to report against', () => {
    const previous = process.env.PATCHSTACK_SITE_UUID;
    delete process.env.PATCHSTACK_SITE_UUID;
    try {
      const reporter = createDetectionReporter({ baseUrl: 'https://x.test/monitor/pulse' });
      expect(() => reporter.record({ rule: pinnedRule, path: '/a' })).not.toThrow();
      expect(() => reporter.flush()).not.toThrow();
    } finally {
      if (previous !== undefined) process.env.PATCHSTACK_SITE_UUID = previous;
    }
  });
});

describe('the helpers', () => {
  it('keeps the path and drops the query', () => {
    expect(routeOf('/api/preview?url=secret')).toBe('/api/preview');
    expect(routeOf('/api/preview#frag')).toBe('/api/preview');
    expect(routeOf('/api/preview')).toBe('/api/preview');
    expect(routeOf('')).toBeNull();
    expect(routeOf(undefined)).toBeNull();
  });

  it('collects the parameters a rule reads, including nested ones', () => {
    // `rules` is a grouping wrapper, not a parameter source — reporting it would name a thing the engine
    // does not read.
    expect(ruleParameters({
      rule_v2: [
        { parameter: 'raw', match: { type: 'contains', value: '__proto__' } },
        { parameter: 'rules', rules: [{ parameter: 'get.q', inclusive: true, match: { type: 'contains', value: 'x' } }] },
      ],
    })).toEqual(['raw', 'get.q']);

    expect(ruleParameters(undefined)).toEqual([]);
    expect(ruleParameters({ rule_v2: 'nonsense' })).toEqual([]);
  });
});

describe('wiring', () => {
  it('reports nothing unless it is switched on', async () => {
    // Opt-in on purpose: enabling it adds an outbound POST to every guard with a site UUID, which is a
    // change in what an installed app does on the network.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ firewall: [], whitelists: [], enforcement: 'dry-run' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      rules: { firewall: [{ ...pinnedRule, rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }] }] },
      mode: 'dry-run',
    });
    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));

    const posted = fetchMock.mock.calls.filter(([url]) => String(url).includes('/detections/'));
    expect(posted.length, 'no detection report without reportDetections: true').toBe(0);

    p.stopRefresh?.();
  });
});
