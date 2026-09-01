import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFirewallLogReporter,
  parseApiKey,
  resolveApiBase,
  telemetryEnabled,
} from '../../src/protect/firewall-log.js';
import { createProtection } from '../../src/protect/runtime.js';

describe('parseApiKey / resolveApiBase', () => {
  it('parses WP-format api_key', () => {
    expect(parseApiKey('abcdefghijabcdefghijabcdefghijabcdefghij-42')).toEqual({
      clientId: '42',
      clientSecret: 'abcdefghijabcdefghijabcdefghijabcdefghij',
    });
    expect(parseApiKey('nope')).toBeNull();
  });

  it('resolveApiBase prefers PATCHSTACK_API_BASE then URL origin', () => {
    process.env.PATCHSTACK_API_BASE = 'https://staging.example/';
    expect(resolveApiBase('https://ignored.test/monitor/pulse')).toBe('https://staging.example');
    delete process.env.PATCHSTACK_API_BASE;
    expect(resolveApiBase('https://x.test/monitor/pulse')).toBe('https://x.test');
  });
});

describe('createFirewallLogReporter (connector /api/logs/log)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.PATCHSTACK_TELEMETRY;
    delete process.env.PATCHSTACK_API_KEY;
    delete process.env.PATCHSTACK_API_BASE;
  });

  it('exchanges oauth token then POSTs firewall logs', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt-token', expires_in: 3600, token_type: 'Bearer' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const reporter = createFirewallLogReporter({
      apiKey: 'sekretsekretsekretsekretsekretsekretsekre-99',
      apiBase: 'https://x.test',
      fetchImpl,
      flushMs: 10,
    });

    reporter.record({ rule: { id: 18843 }, method: 'POST', path: '/api/todos' });
    await vi.advanceTimersByTimeAsync(20);
    // flush kicks off async token+log; drain microtasks
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchImpl).toHaveBeenCalled();
    const tokenCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('/oauth/token'));
    expect(tokenCall).toBeTruthy();
    expect(JSON.parse(tokenCall[1].body)).toEqual({
      grant_type: 'client_credentials',
      client_id: '99',
      client_secret: 'sekretsekretsekretsekretsekretsekretsekre',
    });

    // Allow the async flush to complete
    await vi.waitFor(() => {
      expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('/api/logs/log'))).toBe(true);
    });

    const logCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('/api/logs/log'));
    expect(logCall[1].headers.Authorization).toBe('Bearer jwt-token');
    expect(logCall[1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(logCall[1].body);
    expect(params.get('type')).toBe('firewall');
    const logs = JSON.parse(params.get('logs'));
    expect(logs[0].fid).toBe(18843);
  });

  it('telemetryEnabled respects PATCHSTACK_TELEMETRY=off', () => {
    expect(telemetryEnabled()).toBe(true);
    process.env.PATCHSTACK_TELEMETRY = 'off';
    expect(telemetryEnabled()).toBe(false);
  });
});

describe('createProtection connector log reporting', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.PATCHSTACK_TELEMETRY;
    delete process.env.PATCHSTACK_MODE;
    delete process.env.PATCHSTACK_API_KEY;
  });

  it('POSTs a block via /api/logs/log when apiKey is set', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/rules/')) {
        return new Response(
          JSON.stringify({
            firewall: [
              {
                id: 18843,
                title: 'node-serialize',
                rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '_$$ND_FUNC$$_' } }],
              },
            ],
            whitelists: [],
            whitelist_keys: {},
            enforcement: 'block',
          }),
          { status: 200 },
        );
      }
      if (String(url).includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const protection = await createProtection({
      siteUuid: 'site-1',
      apiKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-7',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      mode: 'block',
      reportManifest: false,
      fetchImpl,
    });

    const blocked = await protection.fetchGuard()(
      new Request('https://app.test/api', {
        method: 'POST',
        body: '_$$ND_FUNC$$_evil',
      }),
    );
    expect(blocked?.status).toBe(403);

    await vi.advanceTimersByTimeAsync(1100);
    await vi.waitFor(() => {
      expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('/api/logs/log'))).toBe(true);
    });

    protection.stopRefresh?.();
  });

  it('does not report without an api key', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/rules/')) {
        return new Response(
          JSON.stringify({
            firewall: [
              {
                id: 18843,
                rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '_$$ND_FUNC$$_' } }],
              },
            ],
            whitelists: [],
            whitelist_keys: {},
            enforcement: 'block',
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const protection = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      mode: 'block',
      reportManifest: false,
      fetchImpl,
    });

    await protection.fetchGuard()(
      new Request('https://app.test/api', { method: 'POST', body: '_$$ND_FUNC$$_evil' }),
    );
    await vi.advanceTimersByTimeAsync(1100);

    expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('/api/logs/log'))).toHaveLength(0);
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('/oauth/token'))).toHaveLength(0);
    protection.stopRefresh?.();
  });
});

describe('stopping the block log waits for what is outstanding, and is bounded', () => {
  const KEY = 'abcdefghijabcdefghijabcdefghijabcdefghij-42';
  const reporter = (fetchImpl: unknown, over: Record<string, unknown> = {}) =>
    createFirewallLogReporter({
      apiKey: KEY,
      apiBase: 'https://api.test',
      fetchImpl: fetchImpl as typeof fetch,
      flushMs: 1,
      ...over,
    });
  const record = (r: any, n = 1) => {
    for (let i = 0; i < n; i++) r.record({ rule: { id: `r${i}` }, method: 'GET', path: '/a', ip: '1.2.3.4' });
  };
  const tick = async () => { await new Promise((r) => setTimeout(r, 5)); };

  afterEach(() => { vi.useRealTimers(); });

  it('waits for a send that was already running when it was called', async () => {
    // A flush that has already taken its batch leaves an empty queue behind it. A shutdown that looked
    // only at the queue would see nothing to wait for while the post was still open.
    let releasePost: ((r: Response) => void) | null = null;
    const impl = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Promise<Response>((resolve) => { releasePost = resolve; });
    });
    const r: any = reporter(impl);

    record(r);
    r.flush();
    await tick();
    expect(releasePost, 'the post is open and the queue is empty').not.toBeNull();

    let settled = false;
    const done = r.stop().then(() => { settled = true; });
    await tick();
    expect(settled, 'the wait found the send the queue no longer knew about').toBe(false);

    releasePost?.(new Response('{}', { status: 200 }));
    await done;
    expect(settled).toBe(true);
  });

  it('returns the same wait when stopped twice', async () => {
    let releasePost: ((r: Response) => void) | null = null;
    const impl = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'jwt', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Promise<Response>((resolve) => { releasePost = resolve; });
    });
    const r: any = reporter(impl);

    record(r);
    r.flush();
    await tick();

    // The second call must not hand back a resolved promise while the first drain is still running, nor
    // start a second drain behind it: it is the same shutdown, so it is the same wait.
    const firstCall = r.stop();
    const secondCall = r.stop();
    expect(secondCall, 'the same wait, not a new one').toBe(firstCall);

    let firstDone = false;
    let secondDone = false;
    const first = firstCall.then(() => { firstDone = true; });
    const second = secondCall.then(() => { secondDone = true; });
    await tick();

    expect(firstDone || secondDone, 'neither has finished yet').toBe(false);
    releasePost?.(new Response('{}', { status: 200 }));
    await Promise.all([first, second]);
    expect(firstDone && secondDone).toBe(true);
  });

  it('gives up on a transport that never answers, and lets go of both phases', async () => {
    vi.useFakeTimers();
    const aborted: string[] = [];
    const impl = vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>(() => {
          init?.signal?.addEventListener('abort', () => {
            aborted.push(String(url).includes('/oauth/token') ? 'token' : 'post');
          });
        }),
    );
    const r: any = reporter(impl);

    record(r);
    let settled = false;
    void r.stop().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled, 'still waiting on the token exchange').toBe(false);

    // A hung transport would otherwise keep a shutdown pending for as long as the process lived.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled, 'the wait is bounded').toBe(true);
    expect(aborted, 'and the open phase was let go of').toContain('token');
  });

  it('aborts a hanging post, not only a hanging token exchange', async () => {
    vi.useFakeTimers();
    const aborted: string[] = [];
    const impl = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).includes('/oauth/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'jwt', expires_in: 3600 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }

      return new Promise<Response>(() => {
        init?.signal?.addEventListener('abort', () => { aborted.push('post'); });
      });
    });
    const r: any = reporter(impl);

    record(r);
    let settled = false;
    void r.stop().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1);

    expect(settled, 'bounded on the post too').toBe(true);
    expect(aborted).toContain('post');
  });
});
