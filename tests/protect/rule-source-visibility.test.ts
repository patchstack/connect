import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * A guard with a live rules source that is not running that source's current rules has a protection
 * gap. It has to be able to say so without the application having wired a callback, and — when nothing
 * else will ask again — it has to ask again until the source answers.
 */

const URL_OPT = 'https://x.test/monitor/pulse';
const CREDENTIAL = 'a-credential-long-enough-to-be-accepted-1234';
const SITE = '33333333-3333-4333-8333-333333333333';
const RULES = {
  firewall: [{ id: 'live-1', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'x' } }] }],
  whitelists: [],
  whitelist_keys: {},
};

/** The rules service, failing until `recoverAfter` rule fetches have been refused. */
function rulesService(recoverAfter = Infinity) {
  let fetches = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!String(url).includes('/rules/')) return new Response('{}', { status: 200 });
      fetches += 1;
      if (fetches <= recoverAfter) return new Response('unavailable', { status: 503 });

      return new Response(JSON.stringify(RULES), { status: 200, headers: { etag: '"v1"' } });
    }),
  );

  return { fetches: () => fetches };
}

const guard = (extra: Record<string, unknown> = {}) =>
  createProtection({ siteUuid: SITE, pulseAuth: CREDENTIAL, pulseRulesUrl: URL_OPT, mode: 'block', reportManifest: false, ...extra });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a guard whose rules are not current', () => {
  it('says what it is running on', async () => {
    rulesService();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p: any = await guard();

    expect(p.ruleSource).toEqual({ ok: false, origin: 'empty', reason: expect.any(String) });
    p.stop();
  });

  it('writes the cause to the console once when no onError is given', async () => {
    rulesService();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p: any = await guard();
    await p.refresh();
    await p.refresh();

    const notCurrent = warn.mock.calls.filter(([m]) => /rules are not current/.test(String(m)));
    expect(notCurrent).toHaveLength(1);
    expect(String(notCurrent[0]![0])).toMatch(/no rules at all/);
    p.stop();
  });

  it('leaves it to onError when one is given', async () => {
    rulesService();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors: unknown[] = [];
    const p: any = await guard({ onError: (e: unknown) => errors.push(e) });

    expect(warn.mock.calls.filter(([m]) => /rules are not current/.test(String(m)))).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    p.stop();
  });

  it('says it is running on its fallback when it has one', async () => {
    rulesService();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p: any = await guard({ rules: RULES });

    expect(p.ruleSource).toMatchObject({ ok: false, origin: 'bundled' });
    expect(warn.mock.calls.some(([m]) => /bundled fallback rules/.test(String(m)))).toBe(true);
    p.stop();
  });

  it('writes nothing when the rules are current', async () => {
    rulesService(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p: any = await guard();

    expect(p.ruleSource).toEqual({ ok: true, origin: 'api' });
    expect(warn.mock.calls.filter(([m]) => /rules are not current/.test(String(m)))).toEqual([]);
    p.stop();
  });
});

describe('a guard with no refresh loop whose first fetch failed', () => {
  it('asks again until the source answers, and then stops asking', async () => {
    vi.useFakeTimers();
    const service = rulesService(2);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p: any = await guard();
    expect(p.rules.request.map((r: any) => r.id)).toEqual([]);

    await vi.advanceTimersByTimeAsync(6_000); // first retry, still failing
    expect(service.fetches()).toBe(2);
    await vi.advanceTimersByTimeAsync(16_000); // second retry, which succeeds
    expect(service.fetches()).toBe(3);
    expect(p.rules.request.map((r: any) => r.id)).toEqual(['live-1']);
    expect(p.ruleSource).toEqual({ ok: true, origin: 'api' });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(service.fetches()).toBe(3);
    p.stop();
  });

  it('keeps asking on a lengthening schedule while the source stays down', async () => {
    vi.useFakeTimers();
    const service = rulesService();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p: any = await guard();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    // Boot, then roughly 5s, 15s, 45s, 2m, 5m, and every 10m after: a handful in an hour, not hundreds.
    expect(service.fetches()).toBeGreaterThan(5);
    expect(service.fetches()).toBeLessThan(15);
    p.stop();
  });

  it('stops asking when the guard is stopped', async () => {
    vi.useFakeTimers();
    const service = rulesService();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p: any = await guard();
    p.stop();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(service.fetches()).toBe(1);
  });

  it('does not ask again without a credential to ask with', async () => {
    // Every site-addressed rules request needs the credential, resolved once at boot; without one the
    // answer is the same refusal forever, and the boot warning already says what is missing.
    vi.useFakeTimers();
    vi.stubEnv('PATCHSTACK_API_KEY', '');
    vi.stubEnv('PATCHSTACK_PULSE_AUTH', '');
    const service = rulesService();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p: any = await createProtection({ siteUuid: SITE, pulseRulesUrl: URL_OPT, mode: 'block', reportManifest: false, cwd: '/nonexistent' });

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(service.fetches()).toBe(1);
    p.stop();
    vi.unstubAllEnvs();
  });

  it('does not add a second schedule to a guard that polls anyway', async () => {
    vi.useFakeTimers();
    const service = rulesService();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p: any = await guard({ refreshMs: 60 * 60 * 1000 });

    await vi.advanceTimersByTimeAsync(50 * 60 * 1000);
    expect(service.fetches()).toBe(1);
    p.stop();
  });
});

describe('rules delivered to block that can only detect', () => {
  it('say so on the console when no onError is given', async () => {
    const scoped = { ...RULES, firewall: [{ ...RULES.firewall[0], id: 'scoped-1', build_scope: 'a'.repeat(64) }] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/rules/')
          ? new Response(JSON.stringify(scoped), { status: 200, headers: { etag: '"s1"' } })
          : new Response('{}', { status: 200 }),
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p: any = await guard();
    await p.refresh();

    const held = warn.mock.calls.filter(([m]) => /build-scoped rule\(s\) are detecting only/.test(String(m)));
    expect(held).toHaveLength(1);
    p.stop();
  });
});

describe('the recovery schedule on its own', () => {
  it('stops at the first clean attempt, whoever else is watching', async () => {
    vi.useFakeTimers();
    const { startRecovery } = await import('../../src/protect/rules/refresh.js');
    let calls = 0;
    const outcomes = [{ ok: false }, { ok: true }];
    startRecovery(async () => outcomes[Math.min(calls++, outcomes.length - 1)]);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(calls).toBe(2);
  });
});
