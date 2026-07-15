import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection, createServerFnGuard } from '../../src/protect/runtime.js';
import { PulseRuleClient } from '../../src/protect/engine/pulse-client.js';

const RULES = {
  firewall: [{ id: 'rm-npm-0001', rule_v2: [{ parameter: 'post.title', match: { type: 'inline_xss' } }] }],
  whitelists: [],
  whitelist_keys: {},
};
const XSS = { title: '<img src=x onerror="steal()">' };
const URL_OPT = 'https://x.test/monitor/pulse';
const blocks = async (p: any) => (await createServerFnGuard({ protection: p })(XSS))?.rule;
const ifNoneMatch = (init: any) => init?.headers?.['If-None-Match'] ?? null;

afterEach(() => vi.restoreAllMocks());

describe('rule sync — conditional fetch (ETag / 304)', () => {
  it('persists the etag, revalidates with If-None-Match, and reuses the cached bundle on 304', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'ps-etag-'));
    const sent: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        sent.push(ifNoneMatch(init));
        if (ifNoneMatch(init) === 'v1') return new Response(null, { status: 304 });
        return new Response(JSON.stringify(RULES), { status: 200, headers: { etag: 'v1' } });
      }),
    );
    try {
      const p1 = await createProtection({ siteUuid: 's', pulseRulesUrl: URL_OPT, cacheDir, mode: 'block' });
      expect(await blocks(p1)).toBe('rm-npm-0001');

      const env = JSON.parse(readFileSync(join(cacheDir, 'patchstack-rules.json'), 'utf8'));
      expect(env.etag).toBe('v1'); // etag persisted alongside the bundle
      expect(env.bundle.firewall[0].id).toBe('rm-npm-0001');

      const p2 = await createProtection({ siteUuid: 's', pulseRulesUrl: URL_OPT, cacheDir, mode: 'block' });
      expect(await blocks(p2)).toBe('rm-npm-0001'); // still blocks — served from cache after a 304

      expect(sent[0]).toBeNull(); // first fetch: no conditional header
      expect(sent[1]).toBe('v1'); // second fetch: revalidated, no re-download
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('is dormant when the API returns no ETag — behaves like a plain full fetch each time', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'ps-noetag-'));
    const sent: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        sent.push(ifNoneMatch(init));
        return new Response(JSON.stringify(RULES), { status: 200 }); // no ETag header
      }),
    );
    try {
      await createProtection({ siteUuid: 's', pulseRulesUrl: URL_OPT, cacheDir, mode: 'block' });
      await createProtection({ siteUuid: 's', pulseRulesUrl: URL_OPT, cacheDir, mode: 'block' });
      expect(sent).toEqual([null, null]); // never sends If-None-Match (nothing to revalidate against)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('PulseRuleClient sends If-None-Match when seeded and reports notModified on 304', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) =>
      ifNoneMatch(init) === 'abc' ? new Response(null, { status: 304 }) : new Response(JSON.stringify(RULES), { status: 200, headers: { etag: 'abc' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res: any = await new PulseRuleClient({ siteUuid: 's', etag: 'abc' }).getRules();
    expect((fetchMock.mock.calls[0]![1] as any).headers['If-None-Match']).toBe('abc');
    expect(res.notModified).toBe(true);
  });
});

describe('rule sync — pluggable cache', () => {
  it('reads/writes a caller-supplied cache adapter instead of disk (last-known-good on failure)', async () => {
    let stored: unknown = null;
    const ruleCache = {
      read: () => stored,
      write: (env: unknown) => {
        stored = env;
      },
    };

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(RULES), { status: 200, headers: { etag: 'v9' } })));
    const p1 = await createProtection({ siteUuid: 's', pulseRulesUrl: URL_OPT, ruleCache, mode: 'block' });
    expect(await blocks(p1)).toBe('rm-npm-0001');
    expect((stored as any).etag).toBe('v9'); // written to the adapter, not disk
    expect((stored as any).bundle.firewall[0].id).toBe('rm-npm-0001');

    // Fetch now fails and there is no bundled fallback — the adapter's last-known-good must block.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('down');
    }));
    const p2 = await createProtection({ siteUuid: 's', pulseRulesUrl: URL_OPT, ruleCache, mode: 'block' });
    expect(await blocks(p2)).toBe('rm-npm-0001');
  });
});
