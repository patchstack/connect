import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { makeStore, sourceIdentity } from '../../src/protect/rules/store.js';

/**
 * A rule cache is one source's last-known-good.
 *
 * The same `cacheDir` can be shared by two sites, by a site and its re-provisioned successor, by the
 * site-UUID and token paths, or by two endpoints. Whatever is cached for one of them must never be
 * enforced by another, revalidated with its ETag, or used to attribute the other's detections.
 */

const URL_OPT = 'https://x.test/monitor/pulse';
const CREDENTIAL = 'a-credential-long-enough-to-be-accepted-1234';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

const bundle = (id: string) => ({
  firewall: [{ id, rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: id } }] }],
  whitelists: [],
  whitelist_keys: {},
});

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  vi.unstubAllGlobals();
});
const cacheDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-cache-identity-'));
  dirs.push(dir);

  return dir;
};

/**
 * The rules service: serves `served` with `etag`, or fails every request when `served` is null. Only
 * rule fetches are recorded — the guard also reports to the platform, and those calls are not what the
 * cases below are about.
 */
function rulesService(served: ReturnType<typeof bundle> | null, etag = '"A1"') {
  const requests: Array<{ url: string; ifNoneMatch: string | null }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers?: Record<string, string> }) => {
      if (!String(url).includes('/rules/')) return new Response('{}', { status: 200 });
      requests.push({ url: String(url), ifNoneMatch: init?.headers?.['If-None-Match'] ?? null });
      if (served === null) return new Response('unavailable', { status: 503 });
      if (init?.headers?.['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { etag } });

      return new Response(JSON.stringify(served), { status: 200, headers: { etag } });
    }),
  );

  return requests;
}

const guard = (dir: string, siteUuid: string, extra: Record<string, unknown> = {}) =>
  createProtection({ siteUuid, pulseAuth: CREDENTIAL, pulseRulesUrl: URL_OPT, cacheDir: dir, mode: 'block', onError: () => {}, ...extra });

const ruleIds = (p: { rules: { request: Array<{ id?: unknown }> } }) => p.rules.request.map((r) => r.id);

describe('a cache written for one site', () => {
  it('is not enforced by another site sharing the directory', async () => {
    const dir = cacheDir();
    rulesService(bundle('site-a-only'));
    await guard(dir, SITE_A);

    rulesService(null);
    const b = await guard(dir, SITE_B);

    expect(ruleIds(b)).not.toContain('site-a-only');
  });

  it('is not revalidated with its ETag by another site', async () => {
    const dir = cacheDir();
    rulesService(bundle('site-a-only'), '"A1"');
    await guard(dir, SITE_A);

    const requests = rulesService(bundle('site-b-only'), '"B1"');
    const b = await guard(dir, SITE_B);

    expect(requests.map((r) => r.ifNoneMatch)).toEqual([null]);
    expect(ruleIds(b)).toEqual(['site-b-only']);
  });

  it('falls back to the second site’s own bundled rules instead', async () => {
    const dir = cacheDir();
    rulesService(bundle('site-a-only'));
    await guard(dir, SITE_A);

    rulesService(null);
    const b = await guard(dir, SITE_B, { rules: bundle('site-b-bundled') });

    expect(ruleIds(b)).toEqual(['site-b-bundled']);
  });

  it('is still the same site’s last-known-good, and still revalidated', async () => {
    const dir = cacheDir();
    rulesService(bundle('site-a-only'), '"A1"');
    await guard(dir, SITE_A);

    const requests = rulesService(null);
    const again = await guard(dir, SITE_A);
    expect(ruleIds(again)).toEqual(['site-a-only']);
    expect(requests.map((r) => r.ifNoneMatch)).toEqual(['"A1"']);
  });

  it('is not enforced against another rules endpoint for the same site', async () => {
    const dir = cacheDir();
    rulesService(bundle('from-one-endpoint'));
    await guard(dir, SITE_A);

    rulesService(null);
    const other = await guard(dir, SITE_A, { pulseRulesUrl: 'https://other.test/monitor/pulse' });

    expect(ruleIds(other)).not.toContain('from-one-endpoint');
  });
});

describe('what the envelope records about its source', () => {
  it('identifies a token source without storing the token', async () => {
    const dir = cacheDir();
    const token = 'tok_' + 'z'.repeat(40);
    const store = makeStore({ cacheDir: dir, token });
    await store.write({ bundle: bundle('t'), etag: 'e' });

    const onDisk = readFileSync(join(dir, 'patchstack-rules.json'), 'utf8');
    expect(onDisk).not.toContain(token);
    expect(JSON.parse(onDisk).source).toBe(await sourceIdentity({ token }));
    expect(await makeStore({ cacheDir: dir, token }).read()).toMatchObject({ etag: 'e' });
    expect(await makeStore({ cacheDir: dir, token: 'tok_' + 'y'.repeat(40) }).read()).toBeNull();
  });

  it('keeps the token and site-UUID paths apart', async () => {
    const dir = cacheDir();
    await makeStore({ cacheDir: dir, token: 'tok_' + 'z'.repeat(40) }).write({ bundle: bundle('t'), etag: 'e' });

    expect(await makeStore({ cacheDir: dir, siteUuid: SITE_A }).read()).toBeNull();
  });

  it('treats a cache that records no source as belonging to none', async () => {
    const dir = cacheDir();
    writeFileSync(join(dir, 'patchstack-rules.json'), JSON.stringify({ bundle: bundle('unattributed'), etag: 'old' }));

    expect(await makeStore({ cacheDir: dir, siteUuid: SITE_A }).read()).toBeNull();
  });

  it('reads nothing when no live source is configured — not even a cache that records none', async () => {
    const dir = cacheDir();
    writeFileSync(join(dir, 'patchstack-rules.json'), JSON.stringify({ bundle: bundle('unattributed'), etag: 'old' }));
    expect(await makeStore({ cacheDir: dir }).read()).toBeNull();

    await makeStore({ cacheDir: dir, siteUuid: SITE_A }).write({ bundle: bundle('a'), etag: 'e' });
    expect(await makeStore({ cacheDir: dir }).read()).toBeNull();
  });

  it('applies to a pluggable cache as well as the filesystem', async () => {
    let held: unknown = null;
    const ruleCache = { read: () => held, write: (e: unknown) => { held = e; } };
    await makeStore({ ruleCache, siteUuid: SITE_A }).write({ bundle: bundle('a'), etag: 'e' });

    expect(await makeStore({ ruleCache, siteUuid: SITE_B }).read()).toBeNull();
    expect(await makeStore({ ruleCache, siteUuid: SITE_A }).read()).toMatchObject({ etag: 'e' });
  });
});
