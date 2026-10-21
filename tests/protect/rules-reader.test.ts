import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProtection } from '../../src/protect/runtime.js';

const READER = `rr_${'a'.repeat(48)}-4242`;
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** A guard with no site credential anywhere, whose bundled rules file carries `_patchstack`. */
async function guard(patchstack: Record<string, unknown>) {
  const cwd = mkdtempSync(join(tmpdir(), 'ps-reader-'));
  dirs.push(cwd);
  vi.stubEnv('PATCHSTACK_API_KEY', '');
  vi.stubEnv('PATCHSTACK_PULSE_AUTH', '');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/token')) {
      return new Response(JSON.stringify({ access_token: 'reader-token', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ firewall: [{ id: 'live-rule', phase: 'request', action: 'block', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'live-attack' } }] }], whitelists: [], whitelist_keys: {}, enforcement: 'block' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  const protection: any = await createProtection({
    siteUuid: '550e8400-e29b-41d4-a716-446655440000',
    pulseRulesUrl: 'https://x.test/monitor/pulse',
    cwd,
    cacheDir: join(cwd, '.patchstack'),
    rules: { firewall: [], whitelists: [], whitelist_keys: {}, _patchstack: patchstack } as never,
    reportDetections: true,
  });
  return { protection, calls };
}

describe('a guard without the site credential, shipped with a rules reader', () => {
  it('fetches live rules with the reader and reports detections on it, as unverified', async () => {
    const { protection, calls } = await guard({ rules_reader: READER });

    const exchange = calls.find((c) => c.url.endsWith('/token'));
    expect(JSON.parse(String(exchange?.init.body))).toMatchObject({ client_id: '4242', client_secret: `rr_${'a'.repeat(48)}` });

    const rules = calls.find((c) => c.url.includes('/rules/'));
    const headers = rules?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer reader-token');

    // Once live rules have resolved, the guard reports on the reader; the platform stores those unverified.
    expect(protection.detectionReporting).toBe('on-unverified');
    expect(await protection.fetchGuard()(new Request('https://app.test/search?q=live-attack'))).toMatchObject({ status: 403 });

    // stop() drains the reporter: the block is posted to the detections endpoint on the reader token.
    await protection.stop();
    const report = calls.find((c) => c.url.includes('/detections/'));
    expect(report).toBeDefined();
    expect((report?.init.headers as Record<string, string>).Authorization).toBe('Bearer reader-token');
  });

  it('on an edge host, delivers the block report via ctx.waitUntil before the runtime is frozen', async () => {
    const { protection, calls } = await guard({ rules_reader: READER });
    expect(protection.detectionReporting).toBe('on-unverified');

    // A Cloudflare-style execution context: the host runs the fetch handler as fetch(request, env, ctx)
    // and freezes the isolate once the response resolves, so background work must go through waitUntil.
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
    const env = {};

    const response = await protection.fetch(() => new Response('ok'))(
      new Request('https://app.test/search?q=live-attack'),
      env,
      ctx,
    );
    expect(response.status).toBe(403);

    // The report rides the context: the host is handed a promise to await before it freezes the isolate,
    // which is what keeps the in-flight POST from being cancelled (the 499 this fixes).
    expect(pending).toHaveLength(1);
    await Promise.all(pending);

    const report = calls.find((c) => c.url.includes('/detections/'));
    expect(report).toBeDefined();
    expect((report?.init.headers as Record<string, string>).Authorization).toBe('Bearer reader-token');
    await protection.stop();
  });

  it('reports the live deployment to /live on the first request it serves', async () => {
    const { protection, calls } = await guard({ rules_reader: READER });
    expect(protection.detectionReporting).toBe('on-unverified');

    await protection.fetchGuard()(new Request('https://my-live-app.example.com/'));

    const live = calls.find((c) => c.url.includes('/live/'));
    expect(live).toBeDefined();
    expect(JSON.parse(String(live?.init.body))).toMatchObject({ origin: 'https://my-live-app.example.com' });
    expect((live?.init.headers as Record<string, string>).Authorization).toBe('Bearer reader-token');
    await protection.stop();
  });

  it('ignores a reader that is not in the issued form', async () => {
    const { protection, calls } = await guard({ rules_reader: 'not-a-reader-1' });

    expect(calls.some((c) => c.url.endsWith('/token'))).toBe(false);
    protection.stop();
  });

  it('uses the site credential instead whenever one resolves', async () => {
    vi.stubEnv('PATCHSTACK_PULSE_AUTH', 'site-own-secret-value-long-enough-0001-77');
    const cwd = mkdtempSync(join(tmpdir(), 'ps-reader-'));
    dirs.push(cwd);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(String(url).endsWith('/token') ? { access_token: 't', expires_in: 3600 } : { firewall: [], whitelists: [], whitelist_keys: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const protection: any = await createProtection({
      siteUuid: '550e8400-e29b-41d4-a716-446655440000', pulseRulesUrl: 'https://x.test/monitor/pulse', cwd, cacheDir: join(cwd, '.patchstack'),
      rules: { firewall: [], whitelists: [], whitelist_keys: {}, _patchstack: { rules_reader: READER } } as never,
    });

    const exchange = calls.find((c) => c.url.endsWith('/token'));
    expect(JSON.parse(String(exchange?.init.body)).client_id).toBe('77');
    protection.stop();
  });
});
