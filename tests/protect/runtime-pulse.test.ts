import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createProtection, createServerFnGuard } from '../../src/protect/runtime.js';

// A single-rule bundle mirroring the Pulse rules endpoint's { firewall, whitelists, whitelist_keys }.
const rules = {
  firewall: [
    {
      id: 'rm-npm-0001',
      title: 'Block stored XSS via vulnerable markdown renderer (marked)',
      rule_v2: [{ parameter: 'post.title', mutations: ['urldecode'], match: { type: 'inline_xss' } }],
    },
  ],
  whitelists: [],
  whitelist_keys: {},
};

const okFetch = () =>
  vi.fn(async () => new Response(JSON.stringify({ firewall: rules.firewall, whitelists: [], whitelist_keys: {} }), { status: 200 }));

describe('createProtection with a siteUuid (live Pulse rules)', () => {
  it('uses rules fetched by site UUID; blocks the exploit', async () => {
    vi.stubGlobal('fetch', okFetch());
    const protection = await createProtection({ siteUuid: 'site-1', pulseRulesUrl: 'https://x.test/monitor/pulse', mode: 'block' });
    const guard = createServerFnGuard({ protection });
    expect((await guard({ title: '<img src=x onerror="steal()">' }))?.rule).toBe('rm-npm-0001');
    expect(await guard({ title: 'buy milk' })).toBeNull();
    vi.restoreAllMocks();
  });

  it('falls back to the bundled rules when the site-UUID fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const protection = await createProtection({ siteUuid: 'site-1', rules, mode: 'block' });
    const guard = createServerFnGuard({ protection });
    expect((await guard({ title: '<img src=x onerror="steal()">' }))?.rule).toBe('rm-npm-0001');
    vi.restoreAllMocks();
  });

  it('prefers the siteUuid (Pulse) source over a WAF token', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await createProtection({ siteUuid: 'site-1', token: 'waf-token', pulseRulesUrl: 'https://x.test/monitor/pulse', mode: 'block' });
    // siteUuid wins: only the Pulse URL is hit; the token/get-rules path is never taken.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://x.test/monitor/pulse/rules/site-1');
    vi.restoreAllMocks();
  });

  it('writes a last-known-good cache and serves it when a later fetch fails', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'ps-cache-'));
    try {
      vi.stubGlobal('fetch', okFetch());
      const p1 = await createProtection({ siteUuid: 'site-1', pulseRulesUrl: 'https://x.test/monitor/pulse', cacheDir, mode: 'block' });
      expect((await createServerFnGuard({ protection: p1 })({ title: '<img src=x onerror="steal()">' }))?.rule).toBe('rm-npm-0001');
      expect(existsSync(join(cacheDir, 'patchstack-rules.json'))).toBe(true);

      // Fetch now fails and there is no bundled fallback — the disk cache must still block.
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
      const p2 = await createProtection({ siteUuid: 'site-1', pulseRulesUrl: 'https://x.test/monitor/pulse', cacheDir, mode: 'block' });
      expect((await createServerFnGuard({ protection: p2 })({ title: '<img src=x onerror="steal()">' }))?.rule).toBe('rm-npm-0001');
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  it('applies a whitelist delivered over the siteUuid path to suppress a matching rule', async () => {
    const bundle = {
      firewall: rules.firewall,
      whitelists: [{ rule_id: 'rm-npm-0001', rule_v2: [{ parameter: 'post.bypass', match: { type: 'equals', value: 'yes' } }] }],
      whitelist_keys: {},
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(bundle), { status: 200 })));
    const guard = createServerFnGuard({ protection: await createProtection({ siteUuid: 'site-1', pulseRulesUrl: 'https://x.test/monitor/pulse', mode: 'block' }) });
    expect((await guard({ title: '<img src=x onerror="steal()">' }))?.rule).toBe('rm-npm-0001'); // blocked
    expect(await guard({ title: '<img src=x onerror="steal()">', bypass: 'yes' })).toBeNull(); // whitelisted
    vi.restoreAllMocks();
  });
});

describe('createProtection live rule refresh (refreshMs)', () => {
  it('hot-swaps in a rule that appears after boot, without recreating the protection', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ firewall: [], whitelists: [], whitelist_keys: {} }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ firewall: rules.firewall, whitelists: [], whitelist_keys: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const protection = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      mode: 'block',
      refreshMs: 1000,
    });
    const guard = createServerFnGuard({ protection });

    // Boot: the site has no rules yet → the exploit is allowed.
    expect(await guard({ title: '<img src=x onerror="steal()">' })).toBeNull();
    expect(protection.rules.request).toHaveLength(0);

    // A refresh tick re-fetches and hot-swaps the (now non-empty) ruleset in place.
    await vi.advanceTimersByTimeAsync(1100);

    expect(protection.rules.request.length).toBeGreaterThan(0);
    expect((await guard({ title: '<img src=x onerror="steal()">' }))?.rule).toBe('rm-npm-0001');

    protection.stopRefresh?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not schedule a refresh when refreshMs is unset', async () => {
    vi.useFakeTimers();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    const protection = await createProtection({ siteUuid: 'site-1', pulseRulesUrl: 'https://x.test/monitor/pulse', mode: 'block' });
    expect(protection.stopRefresh).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the boot fetch — no interval re-fetches

    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not schedule a refresh without a live source, even with refreshMs set', async () => {
    const protection = await createProtection({ rules, mode: 'block', refreshMs: 1000 });
    expect(protection.stopRefresh).toBeUndefined();
  });
});
