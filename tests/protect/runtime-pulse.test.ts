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
