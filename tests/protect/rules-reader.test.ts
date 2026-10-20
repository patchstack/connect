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
  it('fetches live rules with the reader, says it cannot report, and reports nothing', async () => {
    const { protection, calls } = await guard({ rules_reader: READER });

    const exchange = calls.find((c) => c.url.endsWith('/token'));
    expect(JSON.parse(String(exchange?.init.body))).toMatchObject({ client_id: '4242', client_secret: `rr_${'a'.repeat(48)}` });

    const rules = calls.find((c) => c.url.includes('/rules/'));
    const headers = rules?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer reader-token');
    expect(headers['X-Patchstack-Detections']).toBe('unavailable-no-credential');

    expect(protection.detectionReporting).toBe('unavailable-no-credential');
    expect(protection.detectionHealth).toBeUndefined();
    expect(await protection.fetchGuard()(new Request('https://app.test/search?q=live-attack'))).toMatchObject({ status: 403 });
    expect(calls.some((c) => c.url.includes('/detections/'))).toBe(false);
    protection.stop();
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
