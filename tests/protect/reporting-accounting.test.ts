import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notify, resetNotifyWarnings } from '../../src/protect/notify.js';
import { makeRefreshHandler } from '../../src/protect/rules/refresh.js';
import { createFirewallLogReporter } from '../../src/protect/firewall-log.js';
import { createProtection } from '../../src/protect/runtime.js';

const API_KEY = 'samplesamplesamplesamplesamplesamplesamp-7';

describe('callback failure reporting', () => {
  beforeEach(() => resetNotifyWarnings());
  afterEach(() => vi.restoreAllMocks());

  const broken = () => () => {
    throw new Error('sample failure');
  };

  it('reports a second callback under the same hook name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = broken();
    const second = broken();
    notify(first, {}, 'onDetect');
    notify(first, {}, 'onDetect');
    notify(second, {}, 'onDetect');
    notify(second, {}, 'onDetect');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reports one callback once per hook name it is passed as', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shared = broken();
    notify(shared, {}, 'onDetect');
    notify(shared, {}, 'onError');
    notify(shared, {}, 'onError');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reports a failing async callback once per callback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = async () => { throw new Error('sample failure'); };
    const second = async () => { throw new Error('sample failure'); };
    notify(first, {}, 'onSkip');
    notify(first, {}, 'onSkip');
    notify(second, {}, 'onSkip');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('caps the number of warnings a process writes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 40; i++) notify(broken(), {}, 'onDetect');
    expect(warn).toHaveBeenCalledTimes(21);
    expect(String(warn.mock.calls[20][0])).toContain('not reported');
  });

  it('reports each guard whose hook fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rules = {
      firewall: [{ id: 1, title: 'sample', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'SAMPLE' } }] }],
      whitelists: [],
      whitelist_keys: {},
    };
    for (let i = 0; i < 2; i++) {
      const protection: any = await createProtection({ rules, mode: 'dry-run', onDetect: broken() });
      await protection.fetchGuard()(new Request('https://app.example.test/?q=SAMPLE'));
      await protection.stop();
    }
    expect(warn.mock.calls.filter(([m]) => String(m).includes('onDetect'))).toHaveLength(2);
  });
});

describe('refresh secret comparison', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const call = (secret: string, provided?: string) => {
    const tick = vi.fn(async () => ({ ok: true }));
    const headers = provided === undefined ? {} : { 'x-patchstack-refresh': provided };
    return makeRefreshHandler(tick, secret)(new Request('https://app.example.test/refresh', { method: 'POST', headers }))
      .then((response) => ({ status: response.status, ticks: tick.mock.calls.length }));
  };

  it.each([
    ['the configured secret', 'sample-secret-value', 200, 1],
    ['a different secret of the same length', 'sample-secret-valuf', 403, 0],
    ['a prefix', 'sample-secret', 403, 0],
    ['a longer value', 'sample-secret-value-2', 403, 0],
    ['an empty value', '', 403, 0],
    ['no header', undefined, 403, 0],
  ])('answers %s', async (_label, provided, status, ticks) => {
    expect(await call('sample-secret-value', provided)).toEqual({ status, ticks });
  });

  it('compares fixed-length digests of both values', async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    expect((await call('sample-secret-value', 'sample-other')).status).toBe(403);
    const inputs = digest.mock.calls.map(([, data]) => new TextDecoder().decode(data as Uint8Array));
    expect(inputs.sort()).toEqual(['sample-other', 'sample-secret-value']);
  });

  it('still decides correctly without Web Crypto', async () => {
    vi.stubGlobal('crypto', undefined);
    expect((await call('sample-secret-value', 'sample-secret-value')).status).toBe(200);
    expect((await call('sample-secret-value', 'sample-secret-valuf')).status).toBe(403);
    expect((await call('sample-secret-value', 'sample-secret')).status).toBe(403);
    // Characters past the shorter value's end are not read as NUL.
    expect((await call('sample\u0000', 'sample')).status).toBe(403);
  });
});

describe('block-log accounting', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const tokenResponse = () => new Response(JSON.stringify({ access_token: 'sample-token', expires_in: 3600 }), { status: 200 });

  const reporterWith = (logStatus: number | 'hang', tokenOk = true) => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/oauth/token')) return tokenOk ? tokenResponse() : new Response('', { status: 401 });
      if (logStatus === 'hang') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return new Response('{}', { status: logStatus });
    });
    return createFirewallLogReporter({ apiKey: API_KEY, apiBase: 'https://api.example.test', fetchImpl, flushMs: 10 });
  };

  const record = (reporter: any, n: number) => {
    for (let i = 0; i < n; i++) reporter.record({ rule: { id: 1 }, method: 'GET', path: '/' });
  };

  it('counts delivered records', async () => {
    const reporter: any = reporterWith(200);
    record(reporter, 3);
    await vi.advanceTimersByTimeAsync(50);
    expect(reporter.health()).toEqual({ recorded: 3, delivered: 3, failed: 0, dropped: 0, queued: 0 });
  });

  it('counts records in a refused batch as failed', async () => {
    const reporter: any = reporterWith(500);
    record(reporter, 2);
    await vi.advanceTimersByTimeAsync(50);
    expect(reporter.health()).toMatchObject({ recorded: 2, delivered: 0, failed: 2, dropped: 0 });
  });

  it('counts records as failed when no token can be obtained', async () => {
    const reporter: any = reporterWith(200, false);
    record(reporter, 2);
    await vi.advanceTimersByTimeAsync(50);
    expect(reporter.health()).toMatchObject({ recorded: 2, delivered: 0, failed: 2, dropped: 0 });
  });

  it('counts records as failed when the transport throws', async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (String(url).includes('/oauth/token')) return Promise.resolve(tokenResponse());
      throw new Error('sample transport failure');
    });
    const reporter: any = createFirewallLogReporter({ apiKey: API_KEY, apiBase: 'https://api.example.test', fetchImpl, flushMs: 10 });
    record(reporter, 2);
    await vi.advanceTimersByTimeAsync(50);
    expect(reporter.health()).toMatchObject({ recorded: 2, delivered: 0, failed: 2, dropped: 0, queued: 0 });
  });

  it('counts records turned away by a full queue', async () => {
    const reporter: any = reporterWith('hang');
    record(reporter, 600);
    const health = reporter.health();
    expect(health.recorded + health.dropped).toBe(600);
    expect(health.dropped).toBeGreaterThan(0);
    expect(health.recorded).toBe(health.queued + 50);
  });

  it('counts what a shutdown discards as dropped', async () => {
    const reporter: any = reporterWith('hang');
    record(reporter, 120);
    const stopped = reporter.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopped;
    expect(reporter.health()).toEqual({ recorded: 120, delivered: 0, failed: 0, dropped: 120, queued: 0 });
  });

  describe('with a transport that ignores cancellation', () => {
    const balanced = (h: any) => h.recorded === h.delivered + h.failed + h.dropped + h.queued;

    // The post never settles on its own and does not listen to the abort signal; `release` settles it later.
    const ignoringReporter = () => {
      let release: (response: Response) => void = () => {};
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).includes('/oauth/token')) return tokenResponse();
        return new Promise<Response>((resolve) => { release = resolve; });
      });
      const reporter: any = createFirewallLogReporter({ apiKey: API_KEY, apiBase: 'https://api.example.test', fetchImpl, flushMs: 10 });
      return { reporter, release: (response: Response) => release(response) };
    };

    it('accounts for the batch in flight when the shutdown budget runs out', async () => {
      const { reporter } = ignoringReporter();
      record(reporter, 80);
      await vi.advanceTimersByTimeAsync(0);
      const stopped = reporter.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopped;
      const health = reporter.health();
      expect(health).toEqual({ recorded: 80, delivered: 0, failed: 0, dropped: 80, queued: 0 });
      expect(balanced(health)).toBe(true);
    });

    it('does not count the batch again when the transport answers after shutdown', async () => {
      const { reporter, release } = ignoringReporter();
      record(reporter, 80);
      await vi.advanceTimersByTimeAsync(0);
      const stopped = reporter.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopped;
      release(new Response('{}', { status: 200 }));
      await vi.advanceTimersByTimeAsync(20_000);
      const health = reporter.health();
      expect(health).toEqual({ recorded: 80, delivered: 0, failed: 0, dropped: 80, queued: 0 });
      expect(balanced(health)).toBe(true);
    });

    it('keeps the counts balanced when the answer arrives before the budget runs out', async () => {
      const { reporter, release } = ignoringReporter();
      record(reporter, 80);
      await vi.advanceTimersByTimeAsync(0);
      const stopped = reporter.stop();
      release(new Response('{}', { status: 200 }));
      await vi.advanceTimersByTimeAsync(10_000);
      await stopped;
      const health = reporter.health();
      expect(health.delivered).toBeGreaterThanOrEqual(50);
      expect(balanced(health)).toBe(true);
    });
  });

  it('is exposed on the protection object only when the block log is on', async () => {
    const rules = { firewall: [], whitelists: [], whitelist_keys: {} };
    const withLog: any = await createProtection({ rules, apiKey: API_KEY, fetchImpl: async () => new Response('{}') });
    expect(withLog.blockLogHealth()).toEqual({ recorded: 0, delivered: 0, failed: 0, dropped: 0, queued: 0 });
    await withLog.stop();
    const without: any = await createProtection({ rules, reportFirewallLog: false, apiKey: API_KEY });
    expect(without.blockLogHealth).toBeUndefined();
    await without.stop();
  });
});
