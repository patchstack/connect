import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { serialise } from '../../src/protect/rules/refresh.js';

/**
 * Every way a guard can be asked to refresh — the poll loop, recovery, `refresh()`, a push — runs one
 * refresh at a time, so the rules in force are always those of the refresh that started last.
 */

const URL_OPT = 'https://x.test/monitor/pulse';
const CREDENTIAL = 'a-credential-long-enough-to-be-accepted-1234';
const SITE = '44444444-4444-4444-8444-444444444444';
const SECRET = 'a-refresh-secret-for-tests';

const rule = (id: string) => ({ id, rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: id } }] });
const bundle = (...ids: string[]) => ({ firewall: ids.map(rule), whitelists: [], whitelist_keys: {} });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refresh triggers', () => {
  it('never let a slower, older refresh undo a newer one', async () => {
    // Rule fetches in order: boot; a slow one that answers with the rules as they were; then one that
    // carries a rule published since.
    let releaseSlow!: () => void;
    const slowReleased = new Promise<void>((resolve) => (releaseSlow = resolve));
    const answers: Array<() => Promise<Response>> = [
      async () => new Response(JSON.stringify(bundle('base')), { status: 200, headers: { etag: '"1"' } }),
      async () => {
        await slowReleased;
        return new Response(JSON.stringify(bundle('base')), { status: 200, headers: { etag: '"2"' } });
      },
      async () => new Response(JSON.stringify(bundle('base', 'published-later')), { status: 200, headers: { etag: '"3"' } }),
    ];
    let fetches = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!String(url).includes('/rules/')) return new Response('{}', { status: 200 });
        const answer = answers[Math.min(fetches, answers.length - 1)]!;
        fetches += 1;
        return answer();
      }),
    );

    const p: any = await createProtection({
      siteUuid: SITE,
      pulseAuth: CREDENTIAL,
      pulseRulesUrl: URL_OPT,
      refreshSecret: SECRET,
      reportManifest: false,
      mode: 'block',
      onError: () => {},
    });
    const ids = () => p.rules.request.map((r: any) => r.id).sort();

    const slow = p.refresh();
    await new Promise((resolve) => setTimeout(resolve, 10)); // the slow fetch is now in flight
    const pushed = p.refreshHandler()(new Request('https://app.test/refresh', { method: 'POST', headers: { 'x-patchstack-refresh': SECRET } }));
    // The older answer arrives well after a push could have finished on its own — which is exactly the
    // order that lets it land last when the two run side by side.
    setTimeout(releaseSlow, 100);

    expect(await (await pushed).json()).toEqual({ refreshed: true });
    await slow;
    expect(ids()).toEqual(['base', 'published-later']);
    expect(fetches).toBe(3);
    p.stop();
  });
});

describe('the serialiser on its own', () => {
  it('runs one tick at a time, and a call made during one gets a tick that starts after it', async () => {
    const events: string[] = [];
    let n = 0;
    const releases: Array<() => void> = [];
    const tick = serialise(async () => {
      const id = ++n;
      events.push(`start ${id}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      events.push(`end ${id}`);
      return { ok: true, id };
    });

    const first = tick();
    await Promise.resolve();
    const second = tick();
    const third = tick();
    expect(second).toBe(third); // shared: a burst costs one extra tick, not one each

    releases.shift()!();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases.shift()!();

    expect(await second).toEqual({ ok: true, id: 2 });
    expect(events).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('still runs the next tick when the one before it failed', async () => {
    let n = 0;
    const tick = serialise(async () => {
      n += 1;
      if (n === 1) throw new Error('first fails');
      return { ok: true };
    });

    const first = tick();
    const second = tick();

    await expect(first).rejects.toThrow('first fails');
    expect(await second).toEqual({ ok: true });
  });
});
