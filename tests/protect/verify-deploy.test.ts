import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { activationResponse, ACTIVATION_HEADER } from '../../src/protect/activation.js';
import { verifyDeploy } from '../../src/verify-deploy.js';

const siteUuid = '11111111-1111-4111-8111-111111111111';
const secret = 'synthetic-key-1';
const deployment = { siteUuid, buildId: 'a'.repeat(64), manifestChecksum: 'a1234567890c' };
const ready = { ...deployment, source: { ok: true, origin: 'cache' }, matched: true, mapRules: 'ready', mode: 'block' };
const url = 'https://candidate.example.test/fixture';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'connect-readiness-'));
  const file = join(dir, 'deployment.json');
  writeFileSync(file, JSON.stringify(deployment));
  vi.stubEnv('PATCHSTACK_DEPLOYMENT_FILE', file);
  vi.stubEnv('PATCHSTACK_SITE_UUID', siteUuid);
  vi.stubEnv('PATCHSTACK_API_KEY', secret);
  vi.stubEnv('PATCHSTACK_READINESS_URL', url);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function signed(getStatus: () => Record<string, unknown>) {
  return vi.fn(async (target: string, init: RequestInit) => {
    expect(target).toBe(url);
    expect(init.redirect).toBe('error');
    const headers = new Headers(init.headers);
    expect([...headers.keys()]).toEqual([ACTIVATION_HEADER]);
    expect(headers.get(ACTIVATION_HEADER)).not.toContain(secret);
    return activationResponse(new Request(target, init), secret, getStatus);
  });
}

it('waits for pending rules to become ready, even when the rules were revalidated', async () => {
  let probes = 0;
  vi.stubGlobal('fetch', signed(() => ({ ...ready, mapRules: ++probes === 1 ? 'pending' : 'ready' })));
  expect(await verifyDeploy(undefined, 3, true)).toBe(0);
  expect(probes).toBe(2);
});

it.each([
  [{ siteUuid: '22222222-2222-4222-8222-222222222222' }, 'did not prove activation for this site'],
  [{ buildId: 'b'.repeat(64) }, 'different deployment metadata'],
  [{ manifestChecksum: 'b1234567890c' }, 'different deployment metadata'],
  [{ source: { ok: false, origin: 'cache' } }, 'has not confirmed this build'],
  [{ matched: false }, 'has not confirmed this build'],
  [{ mapRules: 'unknown' }, 'has not marked this build ready'],
  [{ mode: 'dry-run' }, 'not ready for blocking mode'],
  [{ devSync: true }, 'not ready for blocking mode'],
])('keeps the gate closed for %j', async (override, reason) => {
  vi.stubGlobal('fetch', signed(() => ({ ...ready, ...override })));
  expect(await verifyDeploy(undefined, 1, true)).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining(reason));
});

it('accepts a ready detect-only deployment when blocking is optional', async () => {
  vi.stubGlobal('fetch', signed(() => ({ ...ready, rules: { request: 0, response: 0 }, mode: 'dry-run' })));
  expect(await verifyDeploy(undefined, 1, false)).toBe(0);
});

it('rejects an unsigned response carrying the same deployment metadata', async () => {
  vi.stubGlobal('fetch', async () => Response.json(ready));
  expect(await verifyDeploy(undefined, 1, false)).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('did not prove activation'));
});

it('checks the artifact before contacting the candidate', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  writeFileSync(join(dir, 'deployment.json'), 'null');
  await expect(verifyDeploy(undefined, 1, false)).rejects.toThrow('completed build');
  expect(fetch).not.toHaveBeenCalled();
});
