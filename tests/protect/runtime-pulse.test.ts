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

describe('createProtection with a siteUuid (live Pulse rules)', () => {
  it('uses rules fetched by site UUID; blocks the exploit', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ firewall: rules.firewall, whitelists: [], whitelist_keys: {} }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
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
});
