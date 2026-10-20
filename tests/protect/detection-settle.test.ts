import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPulseToken } from '../../src/pulse-token.js';
import { createDetectionReporter } from '../../src/protect/detections.js';

const RULE = { id: 'r1', rule_v2: [{ parameter: 'post.title', match: { type: 'contains', value: 'x' } }] };

/** A transport that answers the token exchange and records each detections POST, with a settable status. */
function transport(detectionStatus = 202) {
  const posts: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const target = String(url);
    if (target.endsWith('/token')) {
      return new Response(JSON.stringify({ access_token: 'jwt', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    posts.push(JSON.parse(String(init.body)));
    return new Response('{}', { status: detectionStatus, headers: { 'content-type': 'application/json' } });
  });
  return { fetchImpl, posts };
}

const reporter = (fetchImpl: unknown) =>
  createDetectionReporter({ siteUuid: 'site-1', baseUrl: 'https://x.test/monitor/pulse', pulseAuth: 'site-secret-7', fetchImpl: fetchImpl as typeof fetch });

describe('detection reporter settle()', () => {
  beforeEach(() => clearPulseToken());
  afterEach(() => { clearPulseToken(); vi.restoreAllMocks(); });

  it('resolves only after the recorded detection has been delivered', async () => {
    const { fetchImpl, posts } = transport();
    const r = reporter(fetchImpl);
    r.record({ rule: RULE, phase: 'request', mode: 'block', path: '/a' });

    await r.settle();

    expect(posts).toHaveLength(1);
    expect(posts[0].detections).toHaveLength(1);
    expect(r.health().delivered).toBe(1);
  });

  it('resolves immediately, and sends nothing, when there is nothing to report', async () => {
    const { fetchImpl, posts } = transport();
    const r = reporter(fetchImpl);

    await r.settle();

    expect(posts).toHaveLength(0);
  });

  it('does not stop the reporter — a later detection still delivers', async () => {
    const { fetchImpl, posts } = transport();
    const r = reporter(fetchImpl);
    r.record({ rule: RULE, phase: 'request', mode: 'block', path: '/a' });
    await r.settle();
    r.record({ rule: RULE, phase: 'request', mode: 'block', path: '/b' });
    await r.settle();

    expect(posts).toHaveLength(2);
    expect(r.health().delivered).toBe(2);
  });

  it('is bounded: resolves within its budget even if delivery never acknowledges', async () => {
    vi.useFakeTimers();
    // A transport that answers the token but never resolves the detections POST.
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).endsWith('/token')
        ? new Response(JSON.stringify({ access_token: 'jwt', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Promise<Response>(() => {}),
    );
    const r = reporter(fetchImpl);
    r.record({ rule: RULE, phase: 'request', mode: 'block', path: '/a' });

    let settled = false;
    const wait = r.settle(2_000).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2_001);
    await wait;

    expect(settled).toBe(true);
    vi.useRealTimers();
  });
});
