import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * Backoff on a rule source that is down.
 *
 * Resolving rules is deliberately forgiving: an API or network failure becomes a cached or bundled
 * ruleset rather than an exception, because protection has to keep running. The poller needs the
 * opposite — it needs to know the fetch did not succeed, or every installed guard keeps knocking at its
 * normal interval for as long as the outage lasts, and they all come back at once when it ends.
 */

const RULES = {
  firewall: [{ id: 'r1', title: 'boom', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }] }],
  whitelists: [],
  enforcement: 'dry-run',
};

function rulesEndpoint(state: { fail: boolean }) {
  return vi.fn(async (url: string) => {
    if (state.fail) throw new Error('rule source unreachable');

    return new Response(JSON.stringify(RULES), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

/** Rule fetches only, so the manifest re-post on the same tick cannot be mistaken for one. */
function ruleFetches(fetchMock: { mock: { calls: unknown[][] } }): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/rules/')).length;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the refresh loop', () => {
  it('slows down while the source is unreachable, even though the guard keeps its rules', async () => {
    vi.useFakeTimers();
    const state = { fail: false };
    const fetchMock = rulesEndpoint(state);
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      reportManifest: false,
      refreshMs: 10_000,
    });
    expect(ruleFetches(fetchMock), 'the boot fetch').toBe(1);

    state.fail = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ruleFetches(fetchMock), 'one poll, which could not reach the source').toBe(2);

    // The rules are still in force — the failure is about currency, not protection.
    expect(p.rules.request.length).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(ruleFetches(fetchMock), 'backed off past the next ordinary interval').toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(ruleFetches(fetchMock)).toBe(3);

    p.stop();
  });

  it('returns to the normal interval once the source answers again', async () => {
    // The other half: a backoff that never resets would leave a fleet minutes behind a zero-day rule
    // because of an outage that ended.
    vi.useFakeTimers();
    const state = { fail: true };
    const fetchMock = rulesEndpoint(state);
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      reportManifest: false,
      rules: RULES,
      refreshMs: 10_000,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const failedPolls = ruleFetches(fetchMock);

    state.fail = false;
    // Long enough to get through the backed-off delay and land the recovering poll.
    await vi.advanceTimersByTimeAsync(80_000);
    const recovered = ruleFetches(fetchMock);
    expect(recovered).toBeGreaterThan(failedPolls);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(ruleFetches(fetchMock), 'polling at the configured interval again').toBeGreaterThan(recovered);

    p.stop();
  });

  it('does not back off on a healthy poll', async () => {
    // The control. Without it the first test would pass for a loop that backs off unconditionally.
    vi.useFakeTimers();
    const state = { fail: false };
    const fetchMock = rulesEndpoint(state);
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      reportManifest: false,
      refreshMs: 10_000,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ruleFetches(fetchMock), 'boot plus one poll per interval').toBe(4);

    p.stop();
  });

  it('reports a fallback as an unsuccessful refresh to a caller that asks for one', async () => {
    const state = { fail: false };
    const fetchMock = rulesEndpoint(state);
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      reportManifest: false,
    });

    // Exact, including the origin: a successful refresh took the rules from the platform on this call,
    // which is what makes the site's detections attributable to a managed rule.
    expect(await p.refresh()).toEqual({ ok: true, origin: 'api' });

    state.fail = true;
    const failed = await p.refresh();
    expect(failed.ok).toBe(false);
    expect(typeof failed.reason).toBe('string');

    // Still resolved, not rejected: a manual refresh reports the outcome, and the rules it already had
    // are still loaded.
    expect(p.rules.request.length).toBe(1);

    p.stop();
  });

  it('answers the push endpoint with what actually happened', async () => {
    const state = { fail: true };
    const fetchMock = rulesEndpoint(state);
    vi.stubGlobal('fetch', fetchMock);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      reportManifest: false,
      rules: RULES,
      refreshSecret: 'push-secret',
    });

    const handler = p.refreshHandler();
    const refused = await handler(new Request('https://app.test/refresh', { headers: { 'x-patchstack-refresh': 'push-secret' } }));
    expect(await refused.json()).toEqual({ refreshed: false });

    state.fail = false;
    const ok = await handler(new Request('https://app.test/refresh', { headers: { 'x-patchstack-refresh': 'push-secret' } }));
    expect(await ok.json()).toEqual({ refreshed: true });

    p.stop();
  });
});
