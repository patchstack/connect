import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportManifest } from '../../src/protect/refresh-manifest.js';
import { createProtection } from '../../src/protect/runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'fixtures');
const UUID = '11111111-2222-3333-4444-555555555555';

async function makeProject(withSite = true): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ps-report-'));
  await copyFile(path.join(fixtures, 'package-lock-v3.json'), path.join(dir, 'package-lock.json'));
  if (withSite) {
    await writeFile(path.join(dir, '.patchstackrc.json'), JSON.stringify({ siteUuid: UUID }));
  }
  return dir;
}

describe('reportManifest', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts the lockfile manifest to the Pulse manifest endpoint for the configured site', async () => {
    const dir = await makeProject();
    try {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ stored: true, manifest_id: 1, checksum: 'x', uuid: UUID }), { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await reportManifest(dir);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toContain(`/monitor/pulse/manifest/${UUID}`);
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body));
      expect(body.ecosystem).toBe('npm');
      expect(body.packages.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no-ops without a provisioned site (no .patchstackrc.json)', async () => {
    const dir = await makeProject(false);
    try {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await reportManifest(dir);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createProtection refresh re-posts the manifest (sandbox path)', () => {
  // Real timers here: a refresh tick does real async fs I/O (resolveConfig + scanLockfile), which
  // fake timers don't drain. A short interval + a brief real wait lets a few ticks complete.
  it('re-posts the manifest and re-fetches rules on each tick', async () => {
    const dir = await makeProject();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.includes('/manifest/')) {
        return new Response(JSON.stringify({ stored: true, uuid: UUID }), { status: 200 });
      }
      return new Response(JSON.stringify({ firewall: [], whitelists: [], whitelist_keys: {} }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const protection = await createProtection({
      siteUuid: UUID,
      cwd: dir,
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      mode: 'block',
      refreshMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 120)); // let a few ticks run
      expect(calls.some((c) => c.startsWith('POST') && c.includes('/manifest/'))).toBe(true);
      expect(calls.some((c) => c.includes('/rules/'))).toBe(true);
    } finally {
      protection.stopRefresh?.();
      await rm(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});
