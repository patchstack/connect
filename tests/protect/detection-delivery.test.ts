import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDetectionReporter, retryDelayMs, splitToFit } from '../../src/protect/detections.js';

/**
 * Delivery, not payload.
 *
 * A report is evidence, so losing a batch to a restart or a rate limit is worth one more attempt — and a
 * retry is only safe if a redelivery cannot be counted twice, and only sane if it is bounded. These
 * assert those three together: retried when it is worth it, identified so a duplicate is recognisable,
 * and given up on before an app spends itself on an endpoint that will not take it.
 */
const RULE = { id: 'r1', rule_v2: [{ parameter: 'post.title', match: { type: 'contains', value: 'x' } }] };
const reporterFor = (fetchImpl: unknown, over: Record<string, unknown> = {}) =>
  createDetectionReporter({
    siteUuid: 'site-1',
    baseUrl: 'https://x.test/monitor/pulse',
    fetchImpl: fetchImpl as typeof fetch,
    ...over,
  });

const one = (r: any, path = '/a') => r.record({ rule: RULE, phase: 'request', mode: 'block', path });
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); };
/** Let every scheduled retry run, without waiting out the real backoff. */
const runRetries = async () => {
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS);
    await Promise.resolve();
  }
};
const MAX_ATTEMPTS = 4;
const RETRY_CAP_MS = 30_000;
const keysOf = (impl: any) =>
  impl.mock.calls.map((c: any[]) => (c[1]?.headers ?? {})['Idempotency-Key']).filter(Boolean);

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a batch worth retrying is retried, and only so far', () => {
  it('retries a transient refusal and delivers the same batch', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const impl = vi.fn(async () => {
      attempts++;

      return new Response('{}', { status: attempts < 3 ? 503 : 202 });
    });
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await runRetries();

    expect(attempts, 'it kept trying until the endpoint took it').toBe(3);
    // One event, delivered once — the retries are attempts at the same batch, not more events.
    expect(r.health()).toMatchObject({ sent: 1, delivered: 1, failed: 0, retried: 2 });
    r.stop();
  });

  it('sends every attempt of one batch under the same idempotency key', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const impl = vi.fn(async () => {
      attempts++;

      return new Response('{}', { status: attempts < 3 ? 503 : 202 });
    });
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await runRetries();

    const keys = keysOf(impl);
    expect(keys.length, 'every attempt carried a key').toBe(3);
    expect(new Set(keys).size, 'and it was the same key each time').toBe(1);

    // A different batch is a different key, or the server would discard it as a duplicate.
    one(r, '/b');
    r.flush();
    await runRetries();

    const all = keysOf(impl);
    expect(new Set(all).size, 'the second batch is distinguishable').toBe(2);
    r.stop();
  });

  it('gives up after a bounded number of attempts and counts the loss', async () => {
    vi.useFakeTimers();
    const impl = vi.fn(async () => new Response('{}', { status: 503 }));
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await runRetries();

    expect(impl.mock.calls.length, 'bounded, not a loop').toBe(MAX_ATTEMPTS);
    expect(r.health()).toMatchObject({ sent: 1, delivered: 0, failed: 1 });

    // And nothing is still scheduled: an exhausted batch leaves no timer behind.
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS * 4);
    expect(impl.mock.calls.length, 'no attempt after the bound').toBe(MAX_ATTEMPTS);
    r.stop();
  });

  it('does not retry a refusal that will refuse again', async () => {
    vi.useFakeTimers();
    const impl = vi.fn(async () => new Response('{}', { status: 400 }));
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await runRetries();

    // A rejected batch is rejected on its merits. Retrying it spends the app's time to be told the same
    // thing, where a transient failure has some chance of a different answer.
    expect(impl.mock.calls.length, 'one attempt only').toBe(1);
    expect(r.health()).toMatchObject({ sent: 1, delivered: 0, failed: 1, retried: 0 });
    r.stop();
  });

  it('retries when the endpoint could not be reached at all', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const impl = vi.fn(async () => {
      attempts++;
      if (attempts < 2) throw new Error('connection reset');

      return new Response('{}', { status: 202 });
    });
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await runRetries();

    // Unreachable is not refused: nothing has said the endpoint is unwilling.
    expect(r.health()).toMatchObject({ delivered: 1, failed: 0, retried: 1 });
    r.stop();
  });

  it('schedules nothing new once stopped', async () => {
    vi.useFakeTimers();
    const impl = vi.fn(async () => new Response('{}', { status: 503 }));
    const r = reporterFor(impl);

    one(r);
    r.stop();
    // Under fake timers a real `setTimeout` never fires, so the send is drained by advancing them.
    await vi.advanceTimersByTimeAsync(1);
    const afterStop = impl.mock.calls.length;

    expect(afterStop, 'stopping still sends what was buffered').toBe(1);
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS * 4);
    // A guard being torn down must not leave a timer holding a process open for a report nobody awaits.
    expect(impl.mock.calls.length, 'and does not retry behind the guard').toBe(afterStop);
  });
});

describe('the backoff', () => {
  it('grows, stays bounded, and is jittered', () => {
    // Jitter is what keeps many guards from returning in step after one shared outage.
    expect(retryDelayMs(1, null, () => 0.5)).toBe(1000);
    expect(retryDelayMs(2, null, () => 0.5)).toBe(2000);
    expect(retryDelayMs(3, null, () => 0.5)).toBe(4000);
    expect(retryDelayMs(99, null, () => 0.5)).toBe(30_000);

    // Within ±25%, so jitter can neither collapse the delay to nothing nor exceed the cap.
    expect(retryDelayMs(1, null, () => 0)).toBe(750);
    expect(retryDelayMs(1, null, () => 0.999)).toBeLessThanOrEqual(1250);
    expect(retryDelayMs(99, null, () => 0.999)).toBeLessThanOrEqual(30_000);
  });

  it('honours Retry-After, but not past the cap', () => {
    // The endpoint saying what it can take beats a guess — capped, so a header cannot park a batch.
    expect(retryDelayMs(1, '5')).toBe(5000);
    expect(retryDelayMs(1, '99999')).toBe(30_000);
    expect(retryDelayMs(1, 'not-a-date'), 'an unusable value falls back to the backoff').toBeGreaterThan(0);
    expect(retryDelayMs(1, '-1'), 'and so does a negative one').toBeGreaterThan(0);
  });
});

describe('a reporting state supersedes rather than accumulates', () => {
  it('declares only the newest state when several arrive before a send', async () => {
    const bodies: any[] = [];
    const impl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));

      return new Response('{}', { status: 202 });
    });
    const r = reporterFor(impl);

    r.announce('no-managed-rules');
    r.announce('on');
    await settle();

    const declared = bodies.filter((b) => typeof b.reporting_state === 'string');
    expect(declared.length, 'one declaration, not two').toBe(1);
    expect(declared[0].reporting_state, 'and it is the current state').toBe('on');
    expect(r.health().capability).toMatchObject({ announced: 1, acknowledged: 1 });
    // A declaration carries no events, so it must not move the event counters.
    expect(r.health()).toMatchObject({ sent: 0, delivered: 0 });
    r.stop();
  });

  it('carries a state and the queued events in one request', async () => {
    const bodies: any[] = [];
    const impl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));

      return new Response('{}', { status: 202 });
    });
    const r = reporterFor(impl);

    one(r);
    r.announce('on');
    await settle();

    expect(bodies.length, 'one request, not one each').toBe(1);
    expect(bodies[0].reporting_state).toBe('on');
    expect(bodies[0].detections.length).toBe(1);
    r.stop();
  });

  it('declares a state that arrives while a send is in flight, once that send finishes', async () => {
    const bodies: any[] = [];
    let release: (() => void) | null = null;
    const impl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      if (bodies.length === 1) await new Promise<void>((r) => { release = r; });

      return new Response('{}', { status: 202 });
    });
    const r = reporterFor(impl);

    r.announce('no-managed-rules');
    await settle();
    expect(bodies.length, 'the first declaration is in flight').toBe(1);

    // Two more while it is held. Only the newest should follow.
    r.announce('disabled-by-config');
    r.announce('on');
    release?.();
    await settle();
    await settle();

    expect(bodies.length, 'one follow-up, not two').toBe(2);
    expect(bodies[1].reporting_state).toBe('on');
    r.stop();
  });
});

describe('an event is bounded in size, and says when it was', () => {
  const capture = () => {
    const bodies: any[] = [];
    const impl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));

      return new Response('{}', { status: 202 });
    });

    return { bodies, impl };
  };

  it('shortens a long route and says so', async () => {
    const { bodies, impl } = capture();
    const r = reporterFor(impl);

    r.record({ rule: RULE, phase: 'request', mode: 'block', path: `/${'a'.repeat(500)}` });
    r.flush();
    await settle();

    const event = bodies[0].detections[0];
    expect(event.route.length, 'capped').toBe(256);
    // Without this a reader would take a shortened route for a different route.
    expect(event.truncated).toContain('route');
  });

  it('caps how many parameters an event names, and reports the real count', async () => {
    const { bodies, impl } = capture();
    const r = reporterFor(impl);
    const broad = {
      id: 'broad',
      rule_v2: Array.from({ length: 40 }, (_, i) => ({
        parameter: `post.field_${i}`,
        match: { type: 'contains', value: 'x' },
      })),
    };

    r.record({ rule: broad, phase: 'request', mode: 'block', path: '/a' });
    r.flush();
    await settle();

    const event = bodies[0].detections[0];
    expect(event.parameters.length).toBe(25);
    expect(event.truncated).toContain('parameters');
    expect(event.parameters_total, 'so a reader knows what was left out').toBe(40);
  });

  it('says nothing about truncation when nothing was truncated', async () => {
    const { bodies, impl } = capture();
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await settle();

    const event = bodies[0].detections[0];
    // Absence is not a claim: the field appears only when something really was shortened.
    expect(Object.hasOwn(event, 'truncated')).toBe(false);
    expect(Object.hasOwn(event, 'parameters_total')).toBe(false);
  });

  it('marks a capped identifier instead of passing a shortened one off as whole', async () => {
    const { bodies, impl } = capture();
    const r = reporterFor(impl, { rulesEtag: `"${'e'.repeat(400)}"` });

    r.record({
      rule: { ...RULE, id: 'r'.repeat(400), rule_revision: 'v'.repeat(400) },
      phase: 'request',
      mode: 'block',
      path: '/a',
    });
    r.flush();
    await settle();

    const event = bodies[0].detections[0];
    expect(event.rule_id.length).toBe(256);
    expect(event.rules_etag.length).toBe(256);
    // A shortened identifier no longer names the rule it came from, so saying so is the whole point: a
    // reader must not use it as a key believing it is complete.
    expect(event.truncated).toContain('rule_id');
    expect(event.truncated).toContain('rules_etag');
    r.stop();
  });
});

describe('the byte bound on a batch', () => {
  // Distinguishable, or `toEqual` on the remainder cannot tell a reordering from the right order.
  const event = (bytes: number, id: number) => ({ rule_id: `r${id}`, route: `/${id}`.padEnd(bytes, 'a') });

  it('keeps at least one event even when that one exceeds the bound', () => {
    // A batch of none makes no progress and would retry forever against the same bound.
    const [batch, rest] = splitToFit([event(5000, 1)], 1000);

    expect(batch.length).toBe(1);
    expect(rest.length).toBe(0);
  });

  it('sends what fits and returns the rest in order', () => {
    const events = [event(400, 1), event(400, 2), event(400, 3), event(400, 4)];
    const [batch, rest] = splitToFit(events, 1000);

    expect(batch.length, 'as many as fit').toBeLessThan(events.length);
    expect(JSON.stringify(batch).length).toBeLessThanOrEqual(1000);
    expect(batch.length + rest.length, 'nothing is lost in the split').toBe(events.length);
    // Order matters: the remainder goes back to the front of the queue, so it must still be in sequence.
    expect(rest).toEqual(events.slice(batch.length));
  });

  it('delivers the remainder in a later batch rather than losing it', async () => {
    // The split is only safe if what did not fit comes back. A remainder that is returned and then
    // dropped looks identical to a batch that fit, and the events are simply gone.
    const bodies: any[] = [];
    const impl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));

      return new Response('{}', { status: 202 });
    });
    const r = reporterFor(impl, { rulesEtag: `"${'e'.repeat(254)}"` });
    // Worst-case events: a full batch of these exceeds the body bound, so the split is reached.
    const wide = {
      id: 'r'.repeat(256),
      rule_revision: 'v'.repeat(256),
      rule_v2: Array.from({ length: 25 }, (_, i) => ({
        parameter: `post.${'f'.repeat(58)}${i}`,
        match: { type: 'contains', value: 'x' },
      })),
    };
    for (let i = 0; i < 50; i++) {
      r.record({ rule: wide, phase: 'request', mode: 'block', path: `/${i}`.padEnd(256, 'a') });
    }

    // Drain every batch the queue produces.
    for (let i = 0; i < 6; i++) {
      r.flush();
      await settle();
    }

    expect(bodies.length, 'it took more than one request').toBeGreaterThan(1);
    for (const body of bodies) {
      expect(JSON.stringify(body.detections).length, 'each body is under the bound').toBeLessThanOrEqual(
        64 * 1024,
      );
    }
    const total = bodies.reduce((n, b) => n + b.detections.length, 0);
    expect(total, 'every event arrived').toBe(50);
    expect(r.health()).toMatchObject({ delivered: 50, failed: 0, dropped: 0 });
    r.stop();
  });

  it('sends everything when it all fits', () => {
    const events = [event(10, 1), event(10, 2)];

    expect(splitToFit(events, 1000)).toEqual([events, []]);
  });
});
