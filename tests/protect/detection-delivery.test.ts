import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { clearPulseToken } from '../../src/pulse-token.js';
import {
  byteLength,
  createDetectionReporter,
  retryDelayMs,
  splitToFit,
  worthRetrying,
} from '../../src/protect/detections.js';
// @ts-expect-error -- plain ESM runtime module
import { LIMITS } from '../../src/protect/rules/contract.js';

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

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
    // And nothing else is claimed: no parameter was left out, so there is no total to report.
    expect(event.truncated).not.toContain('parameters');
    expect(Object.hasOwn(event, 'parameters_total')).toBe(false);
  });

  it('keeps a missing route missing rather than turning it into an empty one', async () => {
    const { bodies, impl } = capture();
    const r = reporterFor(impl);

    r.record({ rule: RULE, phase: 'request', mode: 'block' } as never);
    r.flush();
    await settle();

    // There being no route is not the same as the route being empty: an empty string reads as a known
    // path that happens to be blank.
    expect(bodies[0].detections[0].route).toBeNull();
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

  it('marks a shortened parameter list without claiming a size for it', async () => {
    // Two reasons the list is short, and only one of them knows the real total. Shortened by the cap,
    // the total is known. Cut off by the contract's nesting bound it is not, and sending the count of
    // what was seen would state a size nobody established. The mark travels either way, so a short list
    // is always marked as one.
    const { bodies, impl } = capture();
    const r = reporterFor(impl);

    let deep: Record<string, unknown> = { parameter: 'post.hidden', match: { type: 'contains', value: 'x' } };
    for (let i = 0; i <= LIMITS.maxNestingDepth; i++) deep = { parameter: 'rules', rules: [deep] };

    r.record({
      rule: { id: 'deep', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'x' } }, deep] },
      phase: 'request',
      mode: 'block',
      path: '/a',
    });
    r.flush();
    await settle();

    const event = bodies[0].detections[0];
    expect(event.parameters).toEqual(['get.q']);
    expect(event.truncated).toContain('parameters');
    expect(Object.hasOwn(event, 'parameters_total'), 'the total is not known here').toBe(false);
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
    // The rule reads one parameter and the event names it, so a parameter total would be a false claim.
    expect(Object.hasOwn(event, 'parameters_total'), 'no parameters were omitted').toBe(false);
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

describe('stopping leaves nothing outstanding and nothing scheduled', () => {
  const refusing = () => vi.fn(async () => new Response('{}', { status: 503 }));

  it('makes a final attempt at a batch that was waiting to retry, and counts it', async () => {
    vi.useFakeTimers();
    const impl = refusing();
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await vi.advanceTimersByTimeAsync(1);
    expect(impl.mock.calls.length, 'the first attempt failed and a retry is pending').toBe(1);

    r.stop();
    await vi.advanceTimersByTimeAsync(1);

    // Clearing the retry timer alone would leave this batch holding the only slot: never delivered,
    // never abandoned, and absent from every counter.
    expect(impl.mock.calls.length, 'the waiting batch got one last attempt').toBe(2);
    expect(r.health()).toMatchObject({ sent: 1, delivered: 0, failed: 1 });
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS * 4);
    expect(impl.mock.calls.length, 'and nothing after it').toBe(2);
  });

  it('accounts for a waiting batch that finally succeeds on the way out', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const impl = vi.fn(async () => {
      attempts++;

      return new Response('{}', { status: attempts === 1 ? 503 : 202 });
    });
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await vi.advanceTimersByTimeAsync(1);
    r.stop();
    await vi.advanceTimersByTimeAsync(1);

    expect(r.health()).toMatchObject({ sent: 1, delivered: 1, failed: 0 });
  });

  it('drains what is still queued, a batch at a time', async () => {
    vi.useFakeTimers();
    const bodies: any[] = [];
    const impl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));

      return new Response('{}', { status: 202 });
    });
    const r = reporterFor(impl);

    // More than one batch's worth, with nothing due, so it is all still queued.
    for (let i = 0; i < 60; i++) one(r, `/p${i}`);
    r.stop();
    await vi.advanceTimersByTimeAsync(1);

    const total = bodies.reduce((n, b) => n + b.detections.length, 0);
    expect(bodies.length, 'more than one batch left').toBeGreaterThan(1);
    expect(total, 'and all of it went').toBe(60);
    expect(r.health()).toMatchObject({ delivered: 60, dropped: 0 });
  });

  it('counts what it could not send rather than losing track of it', async () => {
    vi.useFakeTimers();
    // A transport that is gone: nothing can be delivered, so the drain has to account for the queue.
    const impl = vi.fn(async () => { throw new Error('gone'); });
    const r = reporterFor(impl);

    for (let i = 0; i < 60; i++) one(r, `/p${i}`);
    r.stop();
    await vi.advanceTimersByTimeAsync(1);

    const h = r.health();
    // Every recorded event ends up somewhere: delivered, refused, or dropped. None simply disappears.
    expect(h.delivered + h.failed + h.dropped, 'all 60 are accounted for').toBe(60);
    expect(h.delivered).toBe(0);
  });

  it('does not start new work when a send already in flight completes after stop', async () => {
    let release: (() => void) | null = null;
    const impl = vi.fn(async () => {
      if (impl.mock.calls.length === 1) await new Promise<void>((r) => { release = r; });

      return new Response('{}', { status: 202 });
    });
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await settle();
    expect(impl.mock.calls.length, 'one send is in flight').toBe(1);

    // Queued behind it, then stopped while it is still running.
    one(r, '/b');
    r.stop();
    release?.();
    await settle();
    await settle();

    // The drain sends what was queued — deliberately, once each — rather than the completion quietly
    // chaining fresh batches behind a stopped guard.
    const total = impl.mock.calls.length;
    await settle();
    expect(impl.mock.calls.length, 'and then it is finished').toBe(total);
    expect(r.health().sent).toBe(2);
  });

  it('ignores a flush or a record that arrives after stopping', async () => {
    const impl = vi.fn(async () => new Response('{}', { status: 202 }));
    const r = reporterFor(impl);

    one(r);
    r.stop();
    await settle();
    const afterStop = impl.mock.calls.length;
    expect(afterStop, 'the drain sent what was buffered').toBe(1);

    // `flush` and `record` are public, so they can be called after a guard is torn down. Neither may
    // start a new request or arm a new interval behind it.
    one(r, '/late');
    r.flush();
    await settle();

    expect(impl.mock.calls.length, 'nothing new was started').toBe(afterStop);
    expect(r.health().sent, 'and the late event was never sent').toBe(1);
  });

  it('accounts for the queue when there is no transport to drain it through', async () => {
    // A runtime with no usable `fetch` can still record. Those events go nowhere, so they have to be
    // counted somewhere rather than sitting in a queue that appears in no number.
    vi.stubGlobal('fetch', undefined);
    const r = createDetectionReporter({ siteUuid: 'site-1', baseUrl: 'https://x.test/monitor/pulse' });

    for (let i = 0; i < 7; i++) one(r, `/p${i}`);
    r.stop();
    await settle();

    const h = r.health();
    expect(h.dropped, 'every unsendable event is accounted for').toBe(7);
    expect(h.sent).toBe(0);
    expect(h.delivered + h.failed).toBe(0);
  });

  it('abandons an attempt that never settles instead of holding the only slot', async () => {
    vi.useFakeTimers();
    const seen: Array<AbortSignal | undefined> = [];
    const impl = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen.push(init?.signal ?? undefined);
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await vi.advanceTimersByTimeAsync(1);
    expect(seen[0], 'the attempt carries a signal').toBeDefined();

    // Ten seconds is the attempt bound; without it this request holds the single send slot for the life
    // of the process and every later event is dropped for pressure.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS);
    expect(impl.mock.calls.length, 'it was abandoned and retried').toBeGreaterThan(1);
    r.stop();
  });

  it('aborts a request in flight when stopped', async () => {
    let aborted = false;
    const impl = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
        }),
    );
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await settle();
    r.stop();
    await settle();

    expect(aborted, 'stopping does not wait on a request that may never answer').toBe(true);
  });
});

describe('what counts as worth retrying', () => {
  it('retries any server error, not a chosen few', () => {
    // The documented contract says a server error is retried. Picking a subset would abandon the rest on
    // the first attempt while the documentation said otherwise.
    for (const status of [500, 501, 502, 503, 504, 507, 508, 599]) {
      expect(worthRetrying(status), `${status} is the endpoint's own fault`).toBe(true);
    }
    for (const status of [408, 425, 429]) expect(worthRetrying(status)).toBe(true);
    expect(worthRetrying(null), 'unreachable says nothing about willingness').toBe(true);
  });

  it('does not retry a refusal on the merits', () => {
    for (const status of [400, 401, 403, 404, 409, 413, 422, 200, 302]) {
      expect(worthRetrying(status), `${status} would refuse again`).toBe(false);
    }
  });
});

describe('the byte bound is measured in bytes, on the request that is sent', () => {
  it('counts what goes on the wire, not UTF-16 code units', () => {
    // A multi-byte character is one code unit and several bytes, so `length` understates the request.
    const multi = '☂'.repeat(100);
    expect(multi.length).toBe(100);
    expect(byteLength(multi), 'three bytes each on the wire').toBe(300);
  });

  it('sizes the whole request, envelope included', () => {
    const events = [{ rule_id: 'a' }, { rule_id: 'b' }];
    const wrap = (batch: unknown[]) => ({ detections: batch, dropped: 0, reporting_state: 'on' });
    const bare = byteLength(JSON.stringify({ detections: events }));
    const full = byteLength(JSON.stringify(wrap(events)));

    // Measuring the events alone leaves the envelope out, so a body just under the bound goes over it.
    expect(full).toBeGreaterThan(bare);
    const [batch] = splitToFit(events, full - 1, wrap as never);
    expect(batch.length, 'the envelope counted against the bound').toBe(1);
  });

  it('keeps a real request under the bound with multi-byte routes', async () => {
    const bodies: string[] = [];
    const impl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));

      return new Response('{}', { status: 202 });
    });
    const r = reporterFor(impl, { rulesEtag: `"${'e'.repeat(254)}"` });
    const wide = {
      id: 'r'.repeat(256),
      rule_v2: Array.from({ length: 25 }, (_, i) => ({
        parameter: `post.${'f'.repeat(58)}${i}`,
        match: { type: 'contains', value: 'x' },
      })),
    };
    // Three bytes per character, so a batch sized by characters would be three times the bound.
    for (let i = 0; i < 50; i++) {
      r.record({ rule: wide, phase: 'request', mode: 'block', path: `/${'☂'.repeat(120)}${i}` });
    }
    for (let i = 0; i < 8; i++) {
      r.flush();
      await settle();
    }

    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      // The actual bytes of the actual request.
      expect(byteLength(body), 'the request that was sent is under the bound').toBeLessThanOrEqual(64 * 1024);
    }
    r.stop();
  });
});

describe('a capability retry is not an event retry', () => {
  it('counts a retried declaration against capability only', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const impl = vi.fn(async () => {
      attempts++;

      return new Response('{}', { status: attempts === 1 ? 503 : 202 });
    });
    const r = reporterFor(impl);

    r.announce('on');
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS);

    const h = r.health();
    // A declaration carries no events, so a retry of it describes no delivery of any event.
    expect(h.retried, 'no event was retried, because none was sent').toBe(0);
    expect(h.capability).toMatchObject({ announced: 1, acknowledged: 1, retried: 1 });
    expect(h.sent).toBe(0);
    r.stop();
  });

  it('counts both when one request carried both', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const impl = vi.fn(async () => {
      attempts++;

      return new Response('{}', { status: attempts === 1 ? 503 : 202 });
    });
    const r = reporterFor(impl);

    one(r);
    r.announce('on');
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS);

    const h = r.health();
    expect(h.retried, 'the events were retried').toBe(1);
    expect(h.capability.retried, 'and so was the declaration').toBe(1);
    r.stop();
  });
});

describe('a detection is posted authenticated, on a cold cache and after revocation', () => {
  // `{secret}-{oauth id}`, the credential shape the exchange parses.
  const AUTH = 'the-secret-40-chars-long-ish-value-here-987';

  /** A transport that exchanges a credential for a token and records what each detection POST carried. */
  const stub = (opts: { tokens?: string[]; detectionStatus?: (n: number) => number } = {}) => {
    const tokens = opts.tokens ?? ['jwt-first', 'jwt-second'];
    let exchanges = 0;
    const posts: Array<{ auth?: string; key?: string }> = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (target.endsWith('/token')) {
        const token = tokens[Math.min(exchanges, tokens.length - 1)];
        exchanges++;

        return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      posts.push({ auth: headers.Authorization, key: headers['Idempotency-Key'] });

      return new Response('{}', { status: opts.detectionStatus?.(posts.length) ?? 202 });
    });

    return { impl, posts, exchanges: () => exchanges };
  };

  beforeEach(() => { clearPulseToken(); });
  afterEach(() => { clearPulseToken(); });

  it('exchanges a credential when nothing is cached', async () => {
    // Boot happens to prime the shared token cache through the rules fetch, so a reporter that could not
    // exchange one itself still looked authenticated — until the cache expired or it ran on its own.
    const { impl, posts, exchanges } = stub();
    const r = reporterFor(impl, { pulseAuth: AUTH });

    one(r);
    r.flush();
    await settle();

    expect(exchanges(), 'it obtained a token of its own').toBe(1);
    expect(posts.length).toBe(1);
    expect(posts[0].auth, 'and the detection went out authenticated').toBe('Bearer jwt-first');
    r.stop();
  });

  it('exchanges again once the cached token has expired', async () => {
    const { impl, posts } = stub({ tokens: ['jwt-short', 'jwt-fresh'] });
    const r = reporterFor(impl, { pulseAuth: AUTH });

    one(r);
    r.flush();
    await settle();
    expect(posts[0].auth).toBe('Bearer jwt-short');

    // What a long-running guard reaches: the token it holds is past its life.
    clearPulseToken();
    one(r, '/b');
    r.flush();
    await settle();

    expect(posts[1].auth, 'a fresh token, not an unauthenticated request').toBe('Bearer jwt-fresh');
    r.stop();
  });

  it('discards a revoked token, retries once, and keeps the same idempotency key', async () => {
    // A credential can be rotated or revoked before the token's own expiry, so the server's 401 is
    // authoritative over our clock. Without this a guard would present a dead token until local expiry
    // and every event in between would be refused.
    const { impl, posts, exchanges } = stub({
      tokens: ['jwt-revoked', 'jwt-reissued'],
      detectionStatus: (n) => (n === 1 ? 401 : 202),
    });
    const r = reporterFor(impl, { pulseAuth: AUTH });

    one(r);
    r.flush();
    await settle();

    expect(posts.length, 'refused once, then sent again').toBe(2);
    expect(posts[0].auth).toBe('Bearer jwt-revoked');
    expect(posts[1].auth, 'with a reissued token').toBe('Bearer jwt-reissued');
    expect(exchanges()).toBe(2);
    // The redelivery must still be recognisable as the same batch.
    expect(posts[1].key, 'the same key as the refused attempt').toBe(posts[0].key);
    expect(r.health()).toMatchObject({ sent: 1, delivered: 1, failed: 0 });
    r.stop();
  });

  it('counts a persistent refusal rather than retrying it forever', async () => {
    vi.useFakeTimers();
    const { impl, posts } = stub({ detectionStatus: () => 401 });
    const r = reporterFor(impl, { pulseAuth: AUTH });

    one(r);
    r.flush();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS * 4);

    // The token path retries a 401 once with a fresh token; a still-refused batch is a refusal on the
    // merits, so the outer retry does not repeat it.
    expect(posts.length, 'two sends, not an endless series').toBe(2);
    expect(r.health()).toMatchObject({ sent: 1, delivered: 0, failed: 1 });
    r.stop();
  });

  it('bounds the credential exchange by the attempt, not by a longer app-wide setting', async () => {
    // The exchange is a separate request, so an attempt's abort does not reach it. Bounded above the
    // attempt it would hold the only send slot past the point the attempt was meant to end.
    const seen: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      seen.push(ms);

      return original(ms);
    });
    const { impl } = stub();
    const r = reporterFor(impl, { pulseAuth: AUTH, timeoutMs: 120_000 });

    one(r);
    r.flush();
    await settle();

    expect(seen.length, 'the exchange bounded itself').toBeGreaterThan(0);
    for (const ms of seen) {
      expect(typeof ms, 'a number, or building the bound throws and the token is lost').toBe('number');
      expect(ms, 'never longer than one attempt').toBeLessThanOrEqual(10_000);
    }
    r.stop();
  });
});

describe('stopping can be awaited', () => {
  it('settles only once the outstanding batch has been delivered', async () => {
    let release: ((r: Response) => void) | null = null;
    const impl = vi.fn(
      () => new Promise<Response>((resolve) => { release = resolve; }),
    );
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await settle();

    let settled = false;
    const done = r.stop().then(() => { settled = true; });
    await settle();

    // A shutdown handler that did not await this would race the last batch against process exit.
    expect(settled, 'not while the request is still open').toBe(false);
    release?.(new Response('{}', { status: 202 }));
    await done;

    expect(settled).toBe(true);
    expect(r.health()).toMatchObject({ delivered: 1 });
  });

  it('settles when there was nothing outstanding', async () => {
    const impl = vi.fn(async () => new Response('{}', { status: 202 }));
    const r = reporterFor(impl);

    await expect(r.stop()).resolves.toBeUndefined();
  });

  it('settles after the drain of a multi-batch queue', async () => {
    const impl = vi.fn(async () => new Response('{}', { status: 202 }));
    const r = reporterFor(impl);

    for (let i = 0; i < 60; i++) one(r, `/p${i}`);
    await r.stop();

    // Awaiting means the queue is finished with, not merely started on.
    expect(r.health()).toMatchObject({ delivered: 60, dropped: 0 });
  });

  it('ends the drain when the budget runs out, rather than only ending the wait', async () => {
    vi.useFakeTimers();
    let landLate: ((r: Response) => void) | null = null;
    let aborted = false;
    const impl = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          landLate = resolve;
          init?.signal?.addEventListener('abort', () => { aborted = true; });
        }),
    );
    const r = reporterFor(impl);

    one(r);
    one(r, '/b');
    r.flush();
    await vi.advanceTimersByTimeAsync(1);

    let settled = false;
    void r.stop().then(() => { settled = true; });
    // A host shutting down has its own deadline, so the wait is bounded.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled, 'the wait ended').toBe(true);

    // And the promise means what it says. Resolving while the request was still open, the queue
    // unaccounted and later batches free to follow would have been a claim of completion that had not
    // happened.
    const atBudget = r.health();
    expect(atBudget.delivered + atBudget.failed + atBudget.dropped, 'everything is accounted for').toBe(2);
    // Not asserted here: `stop()` aborts whatever was open when it was called, so this request was
    // already abandoned before the budget mattered. The test below covers the batch the budget is for.
    expect(aborted, 'the request stop() found was abandoned').toBe(true);
    const sendsAtBudget = impl.mock.calls.length;

    // A response landing after the drain ended must not move a number that has already been reported.
    landLate?.(new Response('{}', { status: 202 }));
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS * 4);

    expect(r.health(), 'the final numbers stayed final').toEqual(atBudget);
    expect(impl.mock.calls.length, 'and nothing followed it').toBe(sendsAtBudget);
  });

  it('abandons a batch the drain itself started, when the budget runs out', async () => {
    vi.useFakeTimers();
    // `stop()` aborts the request it finds. A LATER batch — one the drain starts on its own — is the one
    // only the budget can end, so that is the request this hangs.
    const aborts: boolean[] = [];
    const impl = vi.fn((_u: string, init?: RequestInit) => {
      if (impl.mock.calls.length === 1) return Promise.resolve(new Response('{}', { status: 202 }));
      const index = aborts.length;
      aborts.push(false);

      return new Promise<Response>(() => {
        init?.signal?.addEventListener('abort', () => { aborts[index] = true; });
      });
    });
    const r = reporterFor(impl);

    // Two batches' worth: the first goes, the second hangs.
    for (let i = 0; i < 60; i++) one(r, `/p${i}`);
    const done = r.stop();
    await vi.advanceTimersByTimeAsync(1);
    expect(impl.mock.calls.length, 'the drain moved on to a second batch').toBeGreaterThan(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(aborts.some(Boolean), 'the hanging batch was let go of, not just left open').toBe(true);
    const h = r.health();
    expect(h.delivered + h.failed + h.dropped, 'and all 60 are accounted for').toBe(60);
  });

  it.each([
    ['an acknowledgement', 202],
    ['a refusal worth retrying', 503],
    ['a refusal on the merits', 400],
  ])('ignores %s that lands after the drain ended', async (_what, status) => {
    vi.useFakeTimers();
    let landLate: ((r: Response) => void) | null = null;
    const impl = vi.fn(
      () => new Promise<Response>((resolve) => { landLate = resolve; }),
    );
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await vi.advanceTimersByTimeAsync(1);
    // The budget only elapses once the timers move, so the wait is started and then advanced.
    const done = r.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    const atBudget = r.health();
    const sends = impl.mock.calls.length;

    // Each outcome takes a different path through the attempt, and none of them may reach a counter or
    // schedule a retry once the numbers have been reported as final.
    landLate?.(new Response('{}', { status }));
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS * 4);

    expect(r.health()).toEqual(atBudget);
    expect(impl.mock.calls.length).toBe(sends);
  });

  it('returns the same settled wait when stopped twice', async () => {
    const impl = vi.fn(async () => new Response('{}', { status: 202 }));
    const r = reporterFor(impl);

    one(r);
    const first = r.stop();
    const second = r.stop();
    // The same shutdown, so the same wait — not a fresh promise that settles on its own schedule.
    expect(second, 'the same wait, not a new one').toBe(first);
    await Promise.all([first, second]);

    // A second stop must not restart a drain or hand back a promise nothing will settle.
    expect(impl.mock.calls.length).toBe(1);
  });
});

describe('a redelivery after a refused token appears in the numbers', () => {
  const AUTH = 'the-secret-40-chars-long-ish-value-here-987';

  beforeEach(() => { clearPulseToken(); });
  afterEach(() => { clearPulseToken(); });

  it('counts an authenticated redelivery, apart from a backoff retry', async () => {
    let posts = 0;
    const impl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: `jwt-${posts}`, expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      posts++;

      return new Response('{}', { status: posts === 1 ? 401 : 202 });
    });
    const r = reporterFor(impl, { pulseAuth: AUTH });

    one(r);
    r.flush();
    await settle();

    const h = r.health();
    expect(posts, 'the batch was sent twice').toBe(2);
    // The credential path sends the second one, so it is not a backoff retry — but it IS a redelivery of
    // this batch, and a number that ignored it would say the batch went out once.
    expect(h.reauthorized, 'the redelivery is visible').toBe(1);
    expect(h.retried, 'and is not confused with a backoff retry').toBe(0);
    expect(h).toMatchObject({ sent: 1, delivered: 1 });
    r.stop();
  });

  it('reports no redelivery when the token was accepted', async () => {
    const impl = vi.fn(async (url: string) =>
      String(url).endsWith('/token')
        ? new Response(JSON.stringify({ access_token: 'jwt', expires_in: 3600 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response('{}', { status: 202 }),
    );
    const r = reporterFor(impl, { pulseAuth: AUTH });

    one(r);
    r.flush();
    await settle();

    expect(r.health().reauthorized).toBe(0);
    r.stop();
  });
});

describe('termination finalises everything the reporter was holding', () => {
  const AUTH = 'the-secret-40-chars-long-ish-value-here-987';

  beforeEach(() => { clearPulseToken(); });
  afterEach(() => { clearPulseToken(); });

  it('does not let a credential refresh that lands late move the final numbers', async () => {
    vi.useFakeTimers();
    let releaseSecond: ((r: Response) => void) | null = null;
    let posts = 0;
    const impl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: `jwt-${posts}`, expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      posts++;
      if (posts === 1) return new Response('{}', { status: 401 });

      // The redelivery, held open past the shutdown budget.
      return new Promise<Response>((resolve) => { releaseSecond = resolve; });
    });
    const r = reporterFor(impl, { pulseAuth: AUTH });

    one(r);
    r.flush();
    await vi.advanceTimersByTimeAsync(1);

    const done = r.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    const atBudget = r.health();
    releaseSecond?.(new Response('{}', { status: 202 }));
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS);

    // The redelivery is counted as it is made, under this attempt's epoch — so one completing after the
    // numbers were reported as final cannot change them.
    expect(r.health(), 'the final numbers stayed final').toEqual(atBudget);
  });

  it('accounts for a state that was still waiting for a request', async () => {
    vi.useFakeTimers();
    const impl = vi.fn(() => new Promise<Response>(() => {}));
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await vi.advanceTimersByTimeAsync(1);
    // Queued behind the batch that is now stuck, so it never gets a request of its own.
    r.announce('on');

    const done = r.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    // "The platform was never told my final state" is exactly what a reader of these numbers is after.
    expect(r.health().capability).toMatchObject({ announced: 1, acknowledged: 0, failed: 1 });
  });

  it('leaves no attempt timer scheduled behind a finished shutdown', async () => {
    vi.useFakeTimers();
    const impl = vi.fn(() => new Promise<Response>(() => {}));
    const r = reporterFor(impl);

    one(r);
    r.flush();
    await vi.advanceTimersByTimeAsync(1);
    const whileRunning = vi.getTimerCount();

    const done = r.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    // The attempt's own ten-second bound outlives the five-second budget unless termination clears it.
    expect(vi.getTimerCount(), 'nothing is still scheduled').toBeLessThan(whileRunning);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('captured evidence cannot carry an event past the body bound', () => {
  it('bounds a parameter label a rule left unbounded', async () => {
    // A parameter NAME comes from the rule, and rules carry no length limit — so a label alone can push
    // an event past the body bound. A batch always sends at least one event, so an event that cannot fit
    // could never be delivered at all: the bound has to hold at the wire, whatever produced the capture.
    const bodies: string[] = [];
    const impl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));

      return new Response('{}', { status: 202 });
    });
    const r = reporterFor(impl);
    const enormous = `post.${'p'.repeat(70_000)}`;

    r.record({
      rule: { id: 'r1', rule_v2: [{ parameter: enormous, match: { type: 'contains', value: 'x' } }] },
      phase: 'request',
      mode: 'block',
      path: '/a',
      capture: {
        plan: 'cp2-' + 'f'.repeat(32),
        values: [{ parameter: enormous, value: 'v'.repeat(70_000) }],
      },
    } as never);
    r.flush();
    await settle();

    expect(bodies.length).toBe(1);
    expect(byteLength(bodies[0]), 'the body stayed inside the bound').toBeLessThanOrEqual(64 * 1024);

    const event = JSON.parse(bodies[0]).detections[0];
    expect(event.capture.values[0].parameter.length).toBeLessThanOrEqual(64);
    expect(event.capture.values[0].value.length).toBeLessThanOrEqual(512);
    // Marked, so a reader does not take a shortened label for the parameter's real name.
    expect(event.capture.truncated).toContain('parameter');
    r.stop();
  });

  it('bounds how many captured values one event can carry', async () => {
    const bodies: string[] = [];
    const impl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));

      return new Response('{}', { status: 202 });
    });
    const r = reporterFor(impl);

    r.record({
      rule: { id: 'r1', rule_v2: [{ parameter: 'post.a', match: { type: 'contains', value: 'x' } }] },
      phase: 'request',
      mode: 'block',
      path: '/a',
      capture: {
        plan: 'cp2-' + 'f'.repeat(32),
        // More than any plan permits: the wire gate does not trust what produced the capture.
        values: Array.from({ length: 200 }, (_, i) => ({ parameter: `post.f${i}`, value: `v${i}` })),
      },
    } as never);
    r.flush();
    await settle();

    const event = JSON.parse(bodies[0]).detections[0];
    expect(event.capture.values.length).toBe(10);
    expect(event.capture.truncated).toContain('values');
    r.stop();
  });
});
