import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// `stopRefresh()` ends the rule refresh and nothing else; `stop()` ends everything, including this
// protection's outbound screening.

const URL_OPT = 'https://x.test/monitor/pulse';
const CREDENTIAL = 'a-credential-long-enough-to-be-accepted-1234';
const SITE = '44444444-4444-4444-8444-444444444444';
const RULES = {
  firewall: [{ id: 'live-1', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'x' } }] }],
  whitelists: [],
  whitelist_keys: {},
};

function rulesService(available: boolean) {
  let fetches = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!String(url).includes('/rules/')) return new Response('{}', { status: 200 });
      fetches += 1;
      if (!available) return new Response('unavailable', { status: 503 });

      return new Response(JSON.stringify(RULES), { status: 200, headers: { etag: `"v${fetches}"` } });
    }),
  );

  return { fetches: () => fetches };
}

const live = (extra: Record<string, unknown> = {}) =>
  createProtection({ siteUuid: SITE, pulseAuth: CREDENTIAL, pulseRulesUrl: URL_OPT, mode: 'block', reportManifest: false, ...extra });

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe('stopRefresh()', () => {
  it('stops the poll loop', async () => {
    vi.useFakeTimers();
    const service = rulesService(true);
    const p: any = await live({ refreshMs: 1000 });

    await vi.advanceTimersByTimeAsync(3500);
    const polled = service.fetches();
    expect(polled).toBeGreaterThan(1);

    await p.stopRefresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.fetches()).toBe(polled);
    await p.stop();
  });

  it('stops the retries after an unclean start', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = rulesService(false);
    const p: any = await live();
    expect(service.fetches()).toBe(1);

    await p.stopRefresh();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(service.fetches()).toBe(1);
    await p.stop();
  });

  it('leaves outbound screening in place, which stop() then removes', async () => {
    const stub = (async () => new Response('stub')) as typeof fetch;
    globalThis.fetch = stub;
    const p: any = await createProtection({ egress: true, mode: 'block' });

    await p.stopRefresh();
    await expect(fetch('http://127.0.0.1/admin')).rejects.toThrow(/Patchstack blocked/);

    await p.stop();
    expect(globalThis.fetch).toBe(stub);
    expect(await (await fetch('http://127.0.0.1/admin')).text()).toBe('stub');
  });
});
