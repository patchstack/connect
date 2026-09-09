import { describe, expect, it, vi } from 'vitest';
import { createDetectionReporter } from '../../src/protect/detections.js';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * Which call a detection belongs to.
 *
 * A detection says a rule matched. It does not say WHAT it matched, so two detections cannot be told
 * apart as one call two rules saw from two separate calls — and two rules matching one call is the
 * ordinary case rather than an edge one: a rule that enforces and a rule that only observes are meant to
 * match the same thing, and the response and egress phases both evaluate every rule rather than stopping
 * at the first match. Anything adding these reports up without an identity counts one call twice.
 *
 * What a request and its response share, and what an outbound call does not, is the part worth pinning:
 * the response IS the answer to that request, while an outbound attempt is a thing in its own right and
 * one made outside any request has no request to belong to.
 */
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

  return { reporter, posts };
}

const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

async function reported(detection: Record<string, unknown>) {
  const { reporter, posts } = reporterWith();
  // A rule, because a detection without one is not a report of anything and the reporter drops it.
  reporter.record({
    rule: { id: 'pulse-1', rule_v2: [{ parameter: 'response.body' }] },
    phase: 'response',
    mode: 'dry-run',
    path: '/x',
    ...detection,
  } as any);
  reporter.flush();
  await drain();

  return posts[0].body.detections[0];
}

/** Every identity a run of detections reported, in order. */
function identitiesFrom(detections: Array<{ event: string | null }>) {
  return detections.map((detection) => detection.event);
}

const RESPONSE_RULE = (id: string) => ({
  id,
  phase: 'response',
  category: 'secret-exposure',
  action: 'redact',
  rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'AKIA' } }],
});

const EGRESS_RULE = (id: string) => ({
  id,
  phase: 'egress',
  category: 'ssrf',
  action: 'block',
  rule_v2: [{ parameter: 'egress.host', match: { type: 'internal_host' } }],
});

describe('the reported identity', () => {
  it('carries a correlation token through unchanged', async () => {
    // The shape the guard mints, passed on as it is. What this establishes is that the reporter carries
    // the value rather than deriving or reshaping one — not anything about what the value means, which
    // is settled where it is minted and not visible here.
    expect(await reported({ event: 'a'.repeat(32) })).toMatchObject({ event: 'a'.repeat(32) });
  });

  it('is null when the guard could mint none', async () => {
    // A detection that cannot be grouped is a worse count. It is not a reason to drop a match that
    // really happened.
    expect(await reported({ event: null })).toMatchObject({ event: null });
  });

  it('mints one on a runtime with no web crypto', async () => {
    // Not every runtime this package supports exposes web crypto, and a guard on one of those must still
    // be able to group its detections.
    // The clock and `Math.random` stand in: this identity is never a secret and never a boundary, so
    // what it has to do is not collide between two calls.
    const original = globalThis.crypto;
    // @ts-expect-error — removing it is the situation being reproduced.
    delete (globalThis as any).crypto;

    try {
      const seen: Array<string | null> = [];
      const p: any = await createProtection({
        rules: { firewall: [], whitelists: [], whitelist_keys: {} },
        mode: 'dry-run',
        responseRules: [RESPONSE_RULE('one')],
        onDetect: (detection: any) => seen.push(detection.event ?? null),
      });

      const handler = async () => new Response(JSON.stringify({ field: 'AKIAIOSFODNN7EXAMPLE' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      await p.fetch(handler)(new Request('https://app.test/a', { method: 'GET' }));
      await p.fetch(handler)(new Request('https://app.test/b', { method: 'GET' }));

      expect(seen).toHaveLength(2);
      // Reportable, which is the part that matters: the reporter refuses anything that is not this shape,
      // so a fallback producing something else would be an identity that never reaches the wire.
      for (const identity of seen) expect(identity).toMatch(/^[0-9a-f]{32}$/);
      // And two calls are still two.
      expect(new Set(seen).size).toBe(2);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true, writable: true });
    }
  });

  it('refuses anything that is not the shape this guard mints', async () => {
    // The shape, and only the shape. A value of this shape is not thereby meaningless — a hash of an
    // address has it too — so what this check does is keep the field to one representation and refuse a
    // value that is plainly something else. What makes the token carry nothing is where it comes from,
    // which no check on the value can establish.
    const notTokens = ['203.0.113.7', '/checkout/44', 'user@example.test', 'A'.repeat(32), 'ab', 'f'.repeat(33)];

    for (const value of notTokens) {
      expect((await reported({ event: value })).event, `${value} was reported as an identity`).toBeNull();
    }
  });
});

describe('the cost of not matching', () => {
  it('mints no identity for a request that matches nothing', async () => {
    // A description costs a URL parse, a header read and a token, and most requests match nothing — so
    // none of that is done until there is a detection to describe.
    //
    // Asserted through the randomness the mint draws on, because the identity of a request that raised
    // no detection is not observable any other way — which is the point of not making one.
    const original = globalThis.crypto;
    let draws = 0;
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        ...original,
        getRandomValues: (array: Uint8Array) => {
          draws++;

          return (original as any).getRandomValues(array);
        },
      },
      configurable: true,
      writable: true,
    });

    try {
      const p: any = await createProtection({
        rules: { firewall: [], whitelists: [], whitelist_keys: {} },
        mode: 'dry-run',
        responseRules: [RESPONSE_RULE('one')],
        onDetect: () => {},
      });

      const clean = async () => new Response(JSON.stringify({ field: 'nothing to find here' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      await p.fetch(clean)(new Request('https://app.test/quiet', { method: 'GET' }));

      expect(draws).toBe(0);

      // And the same request shape that DOES match draws once, so the zero above is laziness and not a
      // mint that never happens.
      const leaky = async () => new Response(JSON.stringify({ field: 'AKIAIOSFODNN7EXAMPLE' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      await p.fetch(leaky)(new Request('https://app.test/leaky', { method: 'GET' }));

      expect(draws).toBe(1);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true, writable: true });
    }
  });
});

describe('what shares an identity', () => {
  async function detectionsFrom(
    responseRules: Array<Record<string, unknown>>,
    body: string,
    requests = 1,
  ) {
    const seen: Array<{ event: string | null; phase: string }> = [];
    const p: any = await createProtection({
      rules: { firewall: [], whitelists: [], whitelist_keys: {} },
      mode: 'dry-run',
      responseRules,
      onDetect: (detection: any) => seen.push({ event: detection.event ?? null, phase: detection.phase }),
    });

    for (let i = 0; i < requests; i++) {
      const handler = async () => new Response(JSON.stringify({ field: body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      await p.fetch(handler)(new Request(`https://app.test/page-${i}`, { method: 'GET' }));
    }

    return seen;
  }

  it('gives every rule matching one response the same identity', async () => {
    // The case the whole thing is for: two rules, one call, one event.
    const seen = await detectionsFrom([RESPONSE_RULE('one'), RESPONSE_RULE('two')], 'AKIAIOSFODNN7EXAMPLE');

    expect(seen).toHaveLength(2);
    expect(new Set(identitiesFrom(seen)).size).toBe(1);
    expect(seen[0].event).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives two separate requests different identities', async () => {
    const seen = await detectionsFrom([RESPONSE_RULE('one')], 'AKIAIOSFODNN7EXAMPLE', 2);

    expect(seen).toHaveLength(2);
    expect(new Set(identitiesFrom(seen)).size).toBe(2);
  });

  it('gives a request and the response to it one identity', async () => {
    // The response IS the answer to that request, so a rule matching the body and a rule matching the
    // incoming request are one event seen twice. Minting per phase would report two.
    const seen: Array<{ event: string | null; phase: string }> = [];
    const p: any = await createProtection({
      rules: {
        firewall: [{
          id: 'req-1',
          rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }],
        }],
        whitelists: [],
        whitelist_keys: {},
      },
      mode: 'dry-run',
      responseRules: [RESPONSE_RULE('resp-1')],
      onDetect: (detection: any) => seen.push({ event: detection.event ?? null, phase: detection.phase }),
    });

    const handler = async () => new Response(JSON.stringify({ field: 'AKIAIOSFODNN7EXAMPLE' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await p.fetch(handler)(new Request('https://app.test/page?q=boom', { method: 'GET' }));

    // Both phases fired, or this proves nothing about them agreeing.
    expect(seen.map((d) => d.phase).sort()).toEqual(['request', 'response']);
    expect(new Set(identitiesFrom(seen)).size).toBe(1);
  });
});

describe('an outbound call', () => {
  /**
   * Screening applies to the app's OWN outbound calls, so it is installed over `globalThis.fetch` and
   * the calls are made through it.
   */
  async function egressDetections(rules: Array<Record<string, unknown>>, calls = 1) {
    const seen: Array<{ event: string | null; phase: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('stub')) as any;

    const p: any = await createProtection({
      rules: { firewall: [], whitelists: [], whitelist_keys: {} },
      mode: 'dry-run',
      egress: true,
      egressRules: rules,
      onDetect: (detection: any) => seen.push({ event: detection.event ?? null, phase: detection.phase }),
    });

    try {
      for (let i = 0; i < calls; i++) {
        try {
          await globalThis.fetch(`http://127.0.0.1/${i}`);
        } catch {
          // Dry-run records without preventing, so this should not throw — and whether it does is not
          // what these cases are about.
        }
      }
    } finally {
      p.uninstallEgress?.();
      globalThis.fetch = original;
    }

    return seen;
  }

  it('gives every rule matching one call the same identity', async () => {
    // The egress phase asks every rule rather than stopping at the first match, so two rules refusing
    // one call would otherwise count as two calls refused.
    const seen = await egressDetections([EGRESS_RULE('one'), EGRESS_RULE('two')]);

    expect(seen).toHaveLength(2);
    expect(new Set(identitiesFrom(seen)).size).toBe(1);
    expect(seen[0].event).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives two calls different identities', async () => {
    const seen = await egressDetections([EGRESS_RULE('one')], 2);

    expect(seen).toHaveLength(2);
    expect(new Set(identitiesFrom(seen)).size).toBe(2);
  });
});
