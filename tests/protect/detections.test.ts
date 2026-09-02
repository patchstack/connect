import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDetectionReporter, routeOf, ruleParameters } from '../../src/protect/detections.js';
// @ts-expect-error -- plain ESM runtime module
import { readRuleParameters } from '../../src/protect/rule-parameters.js';
// @ts-expect-error -- plain ESM runtime module
import { LIMITS } from '../../src/protect/rules/contract.js';
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
// `client_ip` is not here: it is omitted when no address could be established, which is the case for a
// reporter driven directly with no resolved address. `client_ip_source` is always present, because "this
// could not be established" is the part a reader needs.
const ALLOWED_KEYS = [
  'rule_id',
  'route',
  'query_keys',
  'method',
  'user_agent',
  'parameters',
  'phase',
  'enforced',
  'rules_etag',
  'rule_revision',
  'client_ip_source',
  'detected_at',
];

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
      query_keys: ['url'],
      parameters: ['server.REQUEST_URI', 'get.url'],
      phase: 'request',
      // The point of the channel: this rule did not block, and that is the interesting case.
      enforced: false,
      rules_etag: '"v7"',
    });
    expect(typeof event.detected_at).toBe('string');
  });

  it('never puts a matched value, a query-string value or a body on the wire', async () => {
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
    for (const forbidden of ['SUPER_SECRET', '169.254.169.254', 'meta-data', '203.0.113.9', 'Blocked by']) {
      expect(wire, `${forbidden} must not reach the reporting endpoint`).not.toContain(forbidden);
    }

    // The user agent DOES travel: attribution is what the channel is for, and a detection without it
    // cannot be told from another client's. It is a header value, and the only one that is sent.
    expect(wire).toContain('curl/8.0');

    // The query's parameter NAMES travel, and none of its values do — which is what makes the scan above
    // meaningful rather than a payload that simply dropped the URL.
    const [event] = posts[0].body.detections;
    expect(event.route).toBe('/api/preview');
    expect(event.query_keys).toEqual(['url', 'token']);
    expect(wire).not.toContain('http://169');
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

  it('collects a condition that names a list of parameters', () => {
    // The engine reads every member of a list, so a rule written this way reads all of them — and a list
    // that omitted them would report the empty set for a rule that reads two, with no cap exceeded and
    // no name shortened, so nothing marking it as short.
    expect(
      ruleParameters({
        rule_v2: [{ parameter: ['get.a', 'post.b'], match: { type: 'contains', value: 'x' } }],
      }),
    ).toEqual(['get.a', 'post.b']);

    // Mixed forms, and a list inside a nested group.
    expect(
      ruleParameters({
        rule_v2: [
          { parameter: 'raw', match: { type: 'contains', value: 'x' } },
          { parameter: 'rules', rules: [{ parameter: ['get.q', 'cookie.sid'], match: { type: 'contains', value: 'x' } }] },
        ],
      }),
    ).toEqual(['raw', 'get.q', 'cookie.sid']);
  });

  it('does not name what the engine cannot read', () => {
    // One level, because the engine expands one level: a nested list resolves to nothing there, so
    // flattening it would name a parameter no match can read, and would grant the plan a permission for
    // one.
    expect(
      ruleParameters({ rule_v2: [{ parameter: [['get.q']], match: { type: 'contains', value: 'x' } }] }),
    ).toEqual([]);

    // `rules` is a grouping wrapper, in the list form as well as the string form.
    expect(
      ruleParameters({ rule_v2: [{ parameter: ['rules', 'get.q'], match: { type: 'contains', value: 'x' } }] }),
    ).toEqual(['get.q']);
  });

  it('says when it could not see the whole rule', () => {
    // A caller that reads this list to decide what a rule is ALLOWED to do needs the difference between
    // "reads no body" and "the walk stopped short of knowing". The bound is the contract's, and rules
    // reach the runtime unvalidated, so it is reachable.
    let deep: Record<string, unknown> = { parameter: 'response.body', match: { type: 'isset' } };
    for (let i = 0; i <= LIMITS.maxNestingDepth; i++) deep = { parameter: 'rules', rules: [deep] };

    const cut = readRuleParameters({ rule_v2: [{ parameter: 'get.q', match: { type: 'isset' } }, deep] });

    expect(cut.complete).toBe(false);
    expect(cut.parameters).toEqual(['get.q']);

    // Inside the bound, the same shape is complete.
    const whole = readRuleParameters({
      rule_v2: [{ parameter: 'rules', rules: [{ parameter: 'get.q', match: { type: 'isset' } }] }],
    });
    expect(whole.complete).toBe(true);
  });

  it('stops where the contract says a rule ends', () => {
    // The bound is the contract's, not a copy: stopping later accepts a rule validation rejects, and
    // stopping earlier calls a valid rule incomplete.
    let deep: Record<string, unknown> = { parameter: 'get.q', match: { type: 'isset' } };
    for (let i = 0; i < LIMITS.maxNestingDepth; i++) deep = { parameter: 'rules', rules: [deep] };

    expect(readRuleParameters({ rule_v2: [deep] }).complete).toBe(true);
    expect(readRuleParameters({ rule_v2: [{ parameter: 'rules', rules: [deep] }] }).complete).toBe(false);
  });

  it('stops following nested groups at a bounded depth', () => {
    // An unbounded walk over a self-referential shape is a stack overflow inside a guard whose contract
    // is to fail open.
    let nested: Record<string, unknown> = { parameter: 'get.deep', match: { type: 'contains', value: 'x' } };
    for (let i = 0; i < 60; i++) nested = { parameter: 'rules', rules: [nested] };

    expect(() => ruleParameters({ rule_v2: [nested] })).not.toThrow();
    // Past the bound, so the deep parameter is not reported — and not reported is the safe direction
    // here, since the engine stops grouping at the same depth.
    expect(ruleParameters({ rule_v2: [nested] })).toEqual([]);
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

describe('declaring the capability', () => {
  it('tells the server reporting is on, on a request it already makes', async () => {
    // Detections are sent only when a rule fires, so silence at the server means nothing matched, or
    // reporting is off, or reports are not arriving — and nothing tells those apart. The rules fetch does,
    // with a header: no new outbound path, no request data, and no client timestamp (the server records
    // when IT saw this, because "alive as of" is the claim a wrong clock would fake).
    const seen: Array<Record<string, string>> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('token')) {
        return new Response(JSON.stringify({ access_token: 'jwt-abc', expires_in: 3600 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      seen.push((init?.headers ?? {}) as Record<string, string>);

      return new Response(JSON.stringify({ firewall: [], whitelists: [], enforcement: 'dry-run' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: 'the-secret-40-chars-long-ish-value-here-987',
      reportDetections: true,
    });

    // Authenticated, so the claim carries weight and is made. The header carries the STATE, not a bit:
    // "no events arrived" has several causes, and the platform can only tell them apart if the guard
    // names which one it is in.
    const claimed = seen.filter((h) => typeof h['X-Patchstack-Detections'] === 'string');
    expect(claimed.length).toBeGreaterThan(0);
    for (const headers of claimed) {
      expect(headers.Authorization, 'the claim only travels on an authenticated request').toContain('Bearer');
      expect(
        ['on', 'no-managed-rules', 'unavailable-no-credential'],
        'the header value is a reporting state',
      ).toContain(headers['X-Patchstack-Detections']);
    }
    // The first fetch of a site with no cached bundle honestly reports that it holds no managed rules
    // yet; the state that follows the resolution is asserted separately below.
    expect(p.detectionReporting).toBe('on');
    p.stopRefresh?.();
  });

  it('says nothing when reporting is off', async () => {
    // The declaration has to mean something: a guard that is not reporting must not claim it is, or the
    // server cannot tell a configured site from an unconfigured one — which is the whole point.
    const seen: Array<Record<string, string>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);

      return new Response(JSON.stringify({ firewall: [], whitelists: [], enforcement: 'dry-run' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({ siteUuid: 'site-1', pulseRulesUrl: 'https://x.test/monitor/pulse' });

    expect(seen.every((h) => h['X-Patchstack-Detections'] === undefined)).toBe(true);
    p.stopRefresh?.();
  });
});

describe('the wiring actually runs', () => {
  it('posts a detection when reporting is switched on', async () => {
    // The gap that let a broken build merge: every other test here either exercised the reporter directly
    // or asserted that NOTHING is posted when the feature is off. Neither enters the branch that builds the
    // reporter, so an unresolved import in it threw only for someone who turned the feature on — which,
    // being opt-in, was nobody. This test is the one that fails if the wiring is broken.
    const posted: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      posted.push(String(url));
      if (String(url).includes('/detections/')) return new Response('{}', { status: 202 });
      if (String(url).includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt-abc', expires_in: 3600 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          firewall: [{ id: 'r1', title: 'boom', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }] }],
          whitelists: [], enforcement: 'dry-run',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: 'the-secret-40-chars-long-ish-value-here-987',
      reportDetections: true,
      detectionFlushMs: 1,
    });

    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));
    p.stopRefresh?.();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(posted.some((url) => url.includes('/detections/site-1'))).toBe(true);
  });
});

describe('the capability claim is only made when it carries weight', () => {
  it('stays silent on an unauthenticated rules fetch', async () => {
    // An unauthenticated request is one whose statements about this site carry no weight, and this header
    // asserts the reassuring thing: that reporting is on. Fetching rules must not hinge on a token —
    // protection comes first — but claiming a capability must.
    const seen: Array<Record<string, string>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);

      return new Response(JSON.stringify({ firewall: [], whitelists: [], enforcement: 'dry-run' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // No credential anywhere: no `pulseAuth`, and nothing for the token exchange to find.
    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      reportDetections: true,
    });

    const rulesRequests = seen.filter((h) => h.Accept === 'application/json');
    expect(rulesRequests.length).toBeGreaterThan(0);
    for (const headers of rulesRequests) {
      expect(headers.Authorization).toBeUndefined();
      expect(headers['X-Patchstack-Detections'], 'an unauthenticated request may not claim the capability')
        .toBeUndefined();
    }

    p.stopRefresh?.();
  });
});

describe('the bundle identity travels with the detection', () => {
  it('attributes a detection to the rules that were running when it fired', async () => {
    // A detection is evidence about a rule document, so it has to name the one that fired. A guard
    // refreshes in place, so the identity it stamps has to move with the swap: attributed to the boot-time
    // bundle, a hit produced by revision B sends a reviewer to revision A's document — which may not even
    // contain the rule.
    const posts: any[] = [];
    let etag = '"v1"';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt-abc', expires_in: 3600 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/detections/')) {
        posts.push(JSON.parse(String(init?.body ?? '{}')));

        return new Response('{}', { status: 202 });
      }

      return new Response(
        JSON.stringify({
          firewall: [{ id: 'r1', title: 'boom', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }] }],
          whitelists: [], enforcement: 'dry-run',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', ETag: etag } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: 'the-secret-40-chars-long-ish-value-here-987',
      reportDetections: true,
      detectionFlushMs: 1,
    });

    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));
    await drain();
    await drain();

    etag = '"v2"';
    await p.refresh();

    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));
    p.stop();
    await drain();
    await drain();

    const stamped = posts.flatMap((body) => body.detections.map((d: any) => d.rules_etag));
    expect(stamped).toEqual(['"v1"', '"v2"']);
  });

  it('keeps the previous identity when a refresh could not reach the source', async () => {
    // The control. A failed refresh keeps the previous rules, so it has to keep the previous identity —
    // moving it would attribute a hit to a bundle this guard never received.
    let fail = false;
    const posts: any[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt-abc', expires_in: 3600 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/detections/')) {
        posts.push(JSON.parse(String(init?.body ?? '{}')));

        return new Response('{}', { status: 202 });
      }
      if (fail) throw new Error('network down');

      return new Response(
        JSON.stringify({
          firewall: [{ id: 'r1', title: 'boom', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }] }],
          whitelists: [], enforcement: 'dry-run',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', ETag: '"v1"' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: 'the-secret-40-chars-long-ish-value-here-987',
      reportDetections: true,
      detectionFlushMs: 1,
    });

    fail = true;
    const status = await p.refresh();
    expect(status.ok, 'a refresh that fell back to cached rules is not a successful refresh').toBe(false);

    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));
    p.stop();
    await drain();
    await drain();

    expect(posts.flatMap((body) => body.detections.map((d: any) => d.rules_etag))).toEqual(['"v1"']);
  });
});

describe('reporting that cannot be delivered', () => {
  it('is not started, and says so', async () => {
    // The detections endpoint requires a verified, site-bound token. A reporter built without a credential
    // would queue every detection, post it, and be refused — an outbound request per batch, while the
    // config says reporting is on.
    const posted: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      posted.push(String(url));

      return new Response(JSON.stringify({
        firewall: [{ id: 'r1', title: 'boom', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }] }],
        whitelists: [], enforcement: 'dry-run',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const warnings: string[] = [];
    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      reportDetections: true,
      detectionFlushMs: 1,
      onError: (err: Error) => warnings.push(err.message),
    });

    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));
    await drain();
    await drain();

    // Distinguished from "off": a boolean would report an undeliverable configuration as a deliberate one.
    expect(p.detectionReporting).toBe('unavailable-no-credential');
    expect(p.detectionHealth, 'no reporter means no health to report').toBeUndefined();
    expect(posted.some((url) => url.includes('/detections/'))).toBe(false);
    expect(warnings.some((m) => m.includes('no API credential resolved'))).toBe(true);

    p.stop();
  });

  it('is started, and named as running, once a credential resolves', async () => {
    // The control: same configuration plus a credential. Without it the assertion above would also pass
    // for an implementation that never reports at all.
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt-abc', expires_in: 3600 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ firewall: [], whitelists: [], enforcement: 'dry-run' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: 'the-secret-40-chars-long-ish-value-here-987',
      reportDetections: true,
    });

    expect(p.detectionReporting).toBe('on');
    expect(typeof p.detectionHealth).toBe('function');
    p.stop();
  });
});

describe('the reporter can always be reached', () => {
  it('flushes on stop, with no refresh loop and no block log installed', async () => {
    // Reporting alone is a valid configuration: no refresh interval, no API key. The final batch must not
    // depend on a timer nobody can bring forward, or a clean shutdown loses it.
    const posts: any[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt-abc', expires_in: 3600 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (target.includes('/detections/')) {
        posts.push(JSON.parse(String(init?.body ?? '{}')));

        return new Response('{}', { status: 202 });
      }

      return new Response(JSON.stringify({
        firewall: [{ id: 'r1', title: 'boom', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }] }],
        whitelists: [], enforcement: 'dry-run',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: 'the-secret-40-chars-long-ish-value-here-987',
      reportDetections: true,
      // The default buffer window, long enough that only an explicit flush can produce the post below.
    });

    expect(typeof p.stop, 'the lifecycle method exists for every configuration').toBe('function');

    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));
    await drain();
    // Counted in EVENTS, not requests: a state announcement is a request carrying no events, and it is
    // made once at boot. What this asserts is that no detection has left the buffer yet.
    const events = () => posts.flatMap((body: any) => body.detections ?? []);
    expect(events().length, 'still buffered — nothing has asked it to flush').toBe(0);

    p.stop();
    await drain();
    await drain();

    // Exactly the one buffered event, delivered by the stop. `sent`/`delivered` count events, so the
    // state announcement — which carries none — does not move them.
    expect(events().length).toBe(1);
    expect(p.detectionHealth()).toMatchObject({ sent: 1, delivered: 1, failed: 0, dropped: 0 });
    expect(p.detectionHealth().lastDeliveredAt).not.toBeNull();
  });
});

describe('delivery health', () => {
  it('separates what was acknowledged from what was refused', async () => {
    // The capability declaration says a guard intends to report. Only an acknowledgement says anything
    // arrived, and without counting the refusals a delivery path that rejects everything reads the same
    // as an app where no rule fired.
    // A terminal refusal, so the outcome is settled on the first attempt: a retryable status would be
    // retried, and this test is about which counter moves, not about when.
    let status = 400;
    const fetchImpl = vi.fn(async () => new Response('{}', { status }));
    const reporter = createDetectionReporter({
      siteUuid: 'site-1',
      baseUrl: 'https://x.test/monitor/pulse',
      rulesEtag: '"v7"',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    reporter.record({ rule: pinnedRule, phase: 'request', mode: 'dry-run', path: '/a' });
    reporter.flush();
    await drain();

    expect(reporter.health()).toMatchObject({ sent: 1, delivered: 0, failed: 1 });
    expect(reporter.health().lastDeliveredAt).toBeNull();

    status = 202;
    reporter.record({ rule: pinnedRule, phase: 'request', mode: 'dry-run', path: '/a' });
    reporter.flush();
    await drain();

    expect(reporter.health()).toMatchObject({ sent: 2, delivered: 1, failed: 1 });
    expect(reporter.health().lastDeliveredAt).not.toBeNull();
  });

  it('counts events dropped for queue pressure, flushed or not', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 }));
    const reporter = createDetectionReporter({
      siteUuid: 'site-1',
      baseUrl: 'https://x.test/monitor/pulse',
      maxQueue: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    for (let i = 0; i < 5; i++) reporter.record({ rule: pinnedRule, phase: 'request', mode: 'dry-run', path: '/a' });

    // Reported before the flush that would carry them, so a snapshot taken between batches is not short.
    expect(reporter.health().dropped).toBe(3);

    reporter.flush();
    await drain();
    expect(reporter.health().dropped).toBe(3);
  });
});

describe('the rule revision travels with the detection', () => {
  it('reports the revision the bundle served for that rule', async () => {
    // The bundle identity says WHICH BUNDLE; it changes whenever anything in the bundle changes, so it
    // cannot say whether one rule's counts describe the document that rule has now. The rule's own revision
    // can, and the side that served it is the side that knows it.
    const { reporter, posts } = reporterWith();

    reporter.record({
      rule: { ...pinnedRule, source_revision: 'sha256:abcdef' },
      phase: 'request',
      mode: 'dry-run',
      path: '/api/preview',
    });
    reporter.flush();
    await drain();

    expect(posts[0].body.detections[0].rule_revision).toBe('sha256:abcdef');
  });

  it('reports a numeric revision as the string it was served as', async () => {
    // A generated rule numbers its revisions; a curated one hashes its document. Both are identifiers, and
    // the reporter forwards rather than interprets.
    const { reporter, posts } = reporterWith();

    reporter.record({ rule: { ...pinnedRule, source_revision: 13 }, phase: 'request', mode: 'dry-run', path: '/a' });
    reporter.flush();
    await drain();

    expect(posts[0].body.detections[0].rule_revision).toBe('13');
  });

  it('reports null when the bundle carried no revision for the rule', async () => {
    // A customer's own rule has none. Null is "cannot say", which the consumer has to be able to tell apart
    // from a revision that no longer matches.
    const { reporter, posts } = reporterWith();

    reporter.record({ rule: pinnedRule, phase: 'request', mode: 'dry-run', path: '/a' });
    reporter.flush();
    await drain();

    expect(posts[0].body.detections[0].rule_revision).toBeNull();
  });

  it('reports no revision for a value that is not one', async () => {
    // An object or a boolean in that field is a served rule this client cannot read, and forwarding it
    // would put an uninterpretable value where a consumer expects an identifier.
    const { reporter, posts } = reporterWith();

    reporter.record({ rule: { ...pinnedRule, source_revision: { v: 1 } }, phase: 'request', mode: 'dry-run', path: '/a' });
    reporter.record({ rule: { ...pinnedRule, source_revision: '' }, phase: 'request', mode: 'dry-run', path: '/a' });
    reporter.flush();
    await drain();

    for (const event of posts[0].body.detections) expect(event.rule_revision).toBeNull();
  });
});

describe('every shortened field says so, including the baseline ones', () => {
  it('marks a capped method, user agent and query-key list, and gives the key total', async () => {
    const { reporter, posts } = reporterWith();
    const manyKeys = Array.from({ length: 25 }, (_, i) => `k${i}=v${i}`).join('&');

    reporter.record({
      rule: pinnedRule,
      phase: 'request',
      mode: 'block',
      path: `/api/preview?${manyKeys}&${'n'.repeat(200)}=x`,
      method: 'M'.repeat(40),
      userAgent: 'u'.repeat(600),
    } as never);
    reporter.flush();
    await drain();

    const [event] = posts[0].body.detections;
    // A cap nobody reports is a cap a reader cannot allow for.
    expect(event.truncated).toContain('method');
    expect(event.truncated).toContain('user_agent');
    expect(event.truncated).toContain('query_keys');
    expect(event.query_keys.length).toBe(10);
    expect(event.query_keys_total, 'so a short list is not read as a complete one').toBe(26);
    expect(event.method.length).toBeLessThanOrEqual(16);
    expect(event.user_agent.length).toBeLessThanOrEqual(256);
  });

  it('says nothing about truncation when the baseline fitted', async () => {
    const { reporter, posts } = reporterWith();

    reporter.record({
      rule: pinnedRule,
      phase: 'request',
      mode: 'block',
      path: '/api/preview?url=x',
      method: 'GET',
      userAgent: 'curl/8.0',
    } as never);
    reporter.flush();
    await drain();

    const [event] = posts[0].body.detections;
    expect(Object.hasOwn(event, 'truncated')).toBe(false);
    expect(Object.hasOwn(event, 'query_keys_total')).toBe(false);
  });
});

describe('the wire gate validates what it is given', () => {
  const withCapture = (capture: unknown) => ({
    rule: pinnedRule,
    phase: 'request',
    mode: 'block',
    path: '/a',
    capture,
  });

  it('counts what it dropped, so eleven values are not mistaken for two hundred', async () => {
    const { reporter, posts } = reporterWith();

    reporter.record(
      withCapture({
        plan: 'cp2-abc',
        omitted: 3,
        values: Array.from({ length: 200 }, (_, i) => ({ parameter: `post.f${i}`, value: `v${i}` })),
      }) as never,
    );
    reporter.flush();
    await drain();

    const { capture } = posts[0].body.detections[0];
    expect(capture.values.length).toBe(10);
    // What the producer left out, plus what this gate did — in the matching counter.
    expect(capture.omitted).toBe(3 + 190);
    expect(Object.hasOwn(capture, 'unsupported'), 'nothing here was refused for its type').toBe(false);
    expect(capture.truncated).toContain('values');
  });

  it('refuses a value whose type this channel does not report, rather than coercing it', async () => {
    const { reporter, posts } = reporterWith();
    // `String(x)` would run whatever `toString` an object carries, turning a refused value into content.
    const hostile = { toString: () => 'SENTINEL-COERCED' };

    reporter.record(
      withCapture({
        plan: 'cp2-abc',
        values: [
          { parameter: 'post.a', value: hostile },
          { parameter: 'post.b', value: 'kept' },
        ],
      }) as never,
    );
    reporter.flush();
    await drain();

    const wire = JSON.stringify(posts[0].body);
    expect(wire).not.toContain('SENTINEL-COERCED');
    const { capture } = posts[0].body.detections[0];
    expect(capture.values).toEqual([{ parameter: 'post.b', value: 'kept' }]);
    // Refused for its type, which is a different fact from a bound leaving it out.
    expect(capture.unsupported, 'counted as unsupported').toBe(1);
    expect(Object.hasOwn(capture, 'omitted'), 'and not as omitted').toBe(false);
  });

  it('refuses a capture whose plan is not a plan', async () => {
    const { reporter, posts } = reporterWith();

    reporter.record(withCapture({ plan: { toString: () => 'SENTINEL-PLAN' }, values: [] }) as never);
    reporter.flush();
    await drain();

    const wire = JSON.stringify(posts[0].body);
    expect(wire).not.toContain('SENTINEL-PLAN');
    expect(Object.hasOwn(posts[0].body.detections[0], 'capture')).toBe(false);
  });

  it('reads the capture once, so a getter cannot answer differently twice', async () => {
    const { reporter, posts } = reporterWith();
    let reads = 0;
    const detection: any = withCapture(undefined);
    Object.defineProperty(detection, 'capture', {
      get() {
        reads += 1;

        return { plan: 'cp2-abc', values: [{ parameter: 'post.a', value: `read-${reads}` }] };
      },
    });

    reporter.record(detection);
    reporter.flush();
    await drain();

    expect(reads, 'one read, so what was checked is what was sent').toBe(1);
    expect(posts[0].body.detections[0].capture.values[0].value).toBe('read-1');
  });
});

describe('the wire gate reads only what the capture itself carries', () => {
  const record = (reporter: any, capture: unknown) =>
    reporter.record({ rule: pinnedRule, phase: 'request', mode: 'block', path: '/a', capture } as never);

  afterEach(() => {
    for (const key of ['raw', 'values', 'plan', 'unavailable']) delete (Object.prototype as any)[key];
  });

  it('does not transmit raw evidence that a prototype supplied', async () => {
    // A plan that permitted nothing must transmit nothing. This guard shields applications against
    // prototype pollution; its own reporting must not be the way one lands.
    const { reporter, posts } = reporterWith();
    (Object.prototype as any).raw = { value: 'SENTINEL-INHERITED-RAW' };

    record(reporter, { plan: 'cp2-abc' });
    reporter.flush();
    await drain();

    const { capture } = posts[0].body.detections[0];
    expect(JSON.stringify(posts[0].body)).not.toContain('SENTINEL-INHERITED-RAW');
    expect(Object.hasOwn(capture, 'raw')).toBe(false);
  });

  it('does not transmit values that a prototype supplied', async () => {
    const { reporter, posts } = reporterWith();
    (Object.prototype as any).values = [{ parameter: 'post.a', value: 'SENTINEL-INHERITED-VALUE' }];

    record(reporter, { plan: 'cp2-abc' });
    reporter.flush();
    await drain();

    expect(JSON.stringify(posts[0].body)).not.toContain('SENTINEL-INHERITED-VALUE');
    expect(Object.hasOwn(posts[0].body.detections[0].capture, 'values')).toBe(false);
  });

  it('does not accept a plan that only a prototype names', async () => {
    const { reporter, posts } = reporterWith();
    (Object.prototype as any).plan = 'cp2-inherited';

    record(reporter, { values: [{ parameter: 'post.a', value: 'v' }] });
    reporter.flush();
    await drain();

    // No plan of its own means no capture at all: a report that named someone else's policy would be
    // worse than one that named none.
    expect(Object.hasOwn(posts[0].body.detections[0], 'capture')).toBe(false);
    expect(JSON.stringify(posts[0].body)).not.toContain('cp2-inherited');
  });

  it('does not let a prototype claim a capture was unavailable', async () => {
    const { reporter, posts } = reporterWith();
    (Object.prototype as any).unavailable = true;

    record(reporter, { plan: 'cp2-abc', values: [{ parameter: 'post.a', value: 'v' }] });
    reporter.flush();
    await drain();

    const { capture } = posts[0].body.detections[0];
    expect(capture.values.length, 'the values were read').toBe(1);
    expect(Object.hasOwn(capture, 'unavailable'), 'and nothing claimed they were not').toBe(false);
  });

  it('does not let an entry inherit its parameter or value', async () => {
    const { reporter, posts } = reporterWith();
    const bare: any = Object.create({ parameter: 'post.inherited', value: 'SENTINEL-INHERITED-ENTRY' });

    record(reporter, { plan: 'cp2-abc', values: [bare, { parameter: 'post.a', value: 'kept' }] });
    reporter.flush();
    await drain();

    const { capture } = posts[0].body.detections[0];
    expect(JSON.stringify(posts[0].body)).not.toContain('SENTINEL-INHERITED-ENTRY');
    expect(capture.values).toEqual([{ parameter: 'post.a', value: 'kept' }]);
    expect(capture.unsupported).toBe(1);
  });
});

describe('reported query names are the names the guard addresses', () => {
  const keysFor = async (query: string) => {
    const { reporter, posts } = reporterWith();

    reporter.record({ rule: pinnedRule, phase: 'request', mode: 'block', path: `/a?${query}` } as never);
    reporter.flush();
    await drain();

    return posts[0].body.detections[0];
  };

  it('reads a plus as a space, as a rule addressing that parameter does', async () => {
    // A rule addresses this parameter as `first name`. Reporting `first+name` would name something no
    // reviewer could look up.
    expect((await keysFor('first+name=x')).query_keys).toEqual(['first name']);
  });

  it('decodes a percent sequence', async () => {
    expect((await keysFor('a%20b=1&%2Fslash=2')).query_keys).toEqual(['a b', '/slash']);
  });

  it('leaves an invalid percent sequence as written, rather than dropping the parameter', async () => {
    expect((await keysFor('bad%ZZ=1')).query_keys).toEqual(['bad%ZZ']);
  });

  it('names a repeated parameter once, and counts distinct names', async () => {
    const event = await keysFor('dup=1&dup=2&dup=3&other=4');

    expect(event.query_keys).toEqual(['dup', 'other']);
    // A parameter repeated three times is one name to look up, so the total describes the list.
    expect(Object.hasOwn(event, 'query_keys_total'), 'nothing was left out').toBe(false);
  });

  it('reports a parameter with no value, and skips one with no name', async () => {
    expect((await keysFor('flag&=novalue&real=1')).query_keys).toEqual(['flag', 'real']);
  });

  it('carries no names when there is no query at all', async () => {
    const { reporter, posts } = reporterWith();

    reporter.record({ rule: pinnedRule, phase: 'request', mode: 'block', path: '/a' } as never);
    reporter.flush();
    await drain();

    expect(posts[0].body.detections[0].query_keys).toEqual([]);
  });
});
