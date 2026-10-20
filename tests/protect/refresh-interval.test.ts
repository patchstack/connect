import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProtection } from '../../src/protect/runtime.js';

const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** A keyed guard written with a 45-minute refresh; returns how many rules fetches it has made. */
async function guard() {
  const cwd = mkdtempSync(join(tmpdir(), 'ps-interval-'));
  dirs.push(cwd);
  let fetches = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/token')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('/rules/')) fetches++;
    return new Response(JSON.stringify({ firewall: [], whitelists: [], whitelist_keys: {}, enforcement: 'block' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  const protection: any = await createProtection({
    siteUuid: '550e8400-e29b-41d4-a716-446655440000',
    pulseRulesUrl: 'https://x.test/monitor/pulse',
    pulseAuth: `${'s'.repeat(40)}-7`,
    cwd,
    cacheDir: join(cwd, '.patchstack'),
    refreshMs: 2_700_000,
    reportManifest: false,
  });
  return { protection, fetches: () => fetches };
}

describe('rules refresh interval', () => {
  it('PATCHSTACK_RULES_REFRESH_SECONDS overrides the interval the guard was written with', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubEnv('PATCHSTACK_RULES_REFRESH_SECONDS', '60');
    const { protection, fetches } = await guard();
    const before = fetches();

    await vi.advanceTimersByTimeAsync(61_000);

    expect(fetches()).toBeGreaterThan(before);
    protection.stop?.();
  });

  it('without it, nothing is fetched again before the written interval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { protection, fetches } = await guard();
    const before = fetches();

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(fetches()).toBe(before);
    protection.stop?.();
  });
});
