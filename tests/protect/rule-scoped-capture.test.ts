import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * A capture permission belongs to a rule, not to the clause that matched.
 *
 * The guard evaluates a rule and reports that the rule matched; it does not record which of the rule's
 * conditions was responsible. So the permissions a rule carries apply to every match of it, whichever
 * condition found one — and a rule that reads both the body and a named parameter, carrying a raw
 * opt-in, attaches a prefix of the body to a match found only in that parameter.
 *
 * The consequence for anyone writing rules: the source is the boundary. A rule that needs the body as
 * evidence reads the body and nothing else; a rule reading a named parameter needs no raw opt-in,
 * because a named value already travels with its detection.
 *
 * These cases hold that from the guard's side. Each request carries a value the rule under test has no
 * permission to see, and the assertion is that it appears nowhere in what is reported. Every rule,
 * marker and value here is synthetic.
 */
const AUTH = 'the-secret-40-chars-long-ish-value-here-987';
const RAW_CHARS = 256;
const MARKER = 'zqx-marker-7f3';
const BODY_SENTINEL = 'BODY-SENTINEL-a1b2c3';
const URI_SENTINEL = 'URI-SENTINEL-d4e5f6';

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

/** Reads the body only, and carries the raw opt-in a body match needs to be reviewable. */
const bodyRule = {
  firewall: [
    {
      id: 'body-rule-under-test',
      title: 'a rule reading the body',
      phase: 'request',
      enforcement: 'dry-run',
      capture: { version: 1, raw_chars: RAW_CHARS },
      rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: MARKER } }],
    },
  ],
  whitelists: [],
  whitelist_keys: {},
};

/** Reads one named parameter, and carries no raw opt-in because it does not need one. */
const namedRule = {
  firewall: [
    {
      id: 'named-rule-under-test',
      title: 'a rule reading a named parameter',
      phase: 'request',
      enforcement: 'dry-run',
      rule_v2: [{ parameter: 'server.REQUEST_URI', match: { type: 'contains', value: MARKER } }],
    },
  ],
  whitelists: [],
  whitelist_keys: {},
};

const guardFor = async (impl: unknown) => {
  vi.stubGlobal('fetch', impl);

  return (await createProtection({
    siteUuid: 'site-1',
    pulseRulesUrl: 'https://x.test/monitor/pulse',
    pulseAuth: AUTH,
    detectionFlushMs: 1,
    mode: 'block',
    fetchImpl: impl as typeof fetch,
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

const responseStub = () => ({
  statusCode: 200,
  setHeader() {}, getHeader() {}, removeHeader() {},
  status() { return this; }, type() { return this; },
  send() { return this; }, json() { return this; }, end() { return this; },
});

/**
 * Run requests through the guard and wait for the reporter to finish.
 *
 * `stop()` is the reporter's own completion signal, so it is awaited rather than approximated with a
 * sleep — a wire assertion that depends on a timer is an assertion that fails under load for a reason
 * that has nothing to do with the code. The timeout rejects rather than resolves: middleware that never
 * calls its callback is a broken test, and resolving would report it as a passing one.
 */
async function through(p: any, requests: Array<Record<string, unknown>>): Promise<void> {
  const res: any = responseStub();

  await Promise.all(
    requests.map(
      (req) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('the guard never called its next callback')), 2000);
          p.express()(expressReq(req), res, () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );

  await p.stop();
}

const eventsFrom = (bodies: any[]) => bodies.flatMap((b) => b.detections ?? []);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a rule reading one named parameter', () => {
  it('reports that parameter as evidence, and none of the body', async () => {
    const { bodies, impl } = stub(namedRule);
    const p = await guardFor(impl);
    await through(p, [{
      url: `/x?q=${MARKER}`,
      originalUrl: `/x?q=${MARKER}`,
      body: { note: BODY_SENTINEL },
    }]);

    const [event] = eventsFrom(bodies);

    expect(event, 'the rule did not fire').toBeDefined();
    // The permission exists and is recorded, so a reader can ask what this capture was allowed to hold.
    expect(event.capture.plan).toMatch(/^cp2-/);
    // Positively: the named value IS the evidence. Asserting only that the body is absent would pass
    // with named capture broken altogether.
    expect(event.capture.values).toEqual([
      { parameter: 'server.REQUEST_URI', value: `/x?q=${MARKER}` },
    ]);
    expect(event.capture.raw ?? null, 'a rule with no opt-in was given the body').toBeNull();
    expect(JSON.stringify(event)).not.toContain(BODY_SENTINEL);
  });

  it('reports nothing when that parameter does not match', async () => {
    // A matching request goes through the same guard, because "nothing was reported" is also what a
    // guard reporting nothing at all looks like.
    const { bodies, impl } = stub(namedRule);
    const p = await guardFor(impl);
    await through(p, [
      { url: '/x?q=ordinary', originalUrl: '/x?q=ordinary', body: { note: BODY_SENTINEL } },
      { url: `/x?q=${MARKER}`, originalUrl: `/x?q=${MARKER}` },
    ]);

    const events = eventsFrom(bodies);

    expect(events, 'the non-matching request was reported, or the matching one was not').toHaveLength(1);
    expect(events[0].capture.values[0].value).toBe(`/x?q=${MARKER}`);
  });
});

describe('a rule reading the body', () => {
  it('reports a bounded prefix of it', async () => {
    const { bodies, impl } = stub(bodyRule);
    const p = await guardFor(impl);
    await through(p, [{ body: { field: MARKER, filler: 'x'.repeat(RAW_CHARS * 2) } }]);

    const [event] = eventsFrom(bodies);

    expect(event, 'the rule did not fire').toBeDefined();
    expect(event.capture.raw.value.length).toBe(RAW_CHARS);
    expect(event.capture.raw.truncated).toBe(true);
  });

  it('reports no value resolved from the request line', async () => {
    // It names no parameter, so nothing resolved from the query is evidence for it. The query still
    // reaches a detection as key NAMES — which fields were present, not what was in them.
    const { bodies, impl } = stub(bodyRule);
    const p = await guardFor(impl);
    await through(p, [{
      url: `/x?token=${URI_SENTINEL}`,
      originalUrl: `/x?token=${URI_SENTINEL}`,
      query: { token: URI_SENTINEL },
      body: { field: MARKER },
    }]);

    const [event] = eventsFrom(bodies);

    expect(event, 'the rule did not fire').toBeDefined();
    expect(event.capture.values ?? []).toEqual([]);
    expect(event.query_keys).toContain('token');
    expect(JSON.stringify(event), 'a query value reached the report').not.toContain(URI_SENTINEL);
    expect(event.route, 'the route carried the query string').not.toContain('token=');
  });

  it('reports a match found past the bound, and says the evidence was cut', async () => {
    // The opt-in bounds what may be SHOWN, not what may match. So a detection arrives whose evidence
    // does not contain what matched, and `truncated` is what separates that from a rule that matched
    // nothing — a reader treating it as a false positive would retire a rule for matching something it
    // was not permitted to show.
    const { bodies, impl } = stub(bodyRule);
    const p = await guardFor(impl);
    await through(p, [{ body: { filler: 'y'.repeat(RAW_CHARS * 2), field: MARKER } }]);

    const [event] = eventsFrom(bodies);

    expect(event, 'the rule did not fire').toBeDefined();
    expect(event.capture.raw.truncated).toBe(true);
    expect(event.capture.raw.value).not.toContain(MARKER);
  });

  it('reports nothing when the body does not match', async () => {
    const { bodies, impl } = stub(bodyRule);
    const p = await guardFor(impl);
    await through(p, [
      { body: { note: BODY_SENTINEL } },
      { body: { field: MARKER } },
    ]);

    const events = eventsFrom(bodies);

    expect(events, 'the non-matching request was reported, or the matching one was not').toHaveLength(1);
    expect(JSON.stringify(events[0]), 'the non-matching body reached the report').not.toContain(BODY_SENTINEL);
  });
});
