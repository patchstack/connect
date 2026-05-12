import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveConfig, writeConfigFile } from '../src/config.js';
import { DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS } from '../src/client.js';
import { PatchstackError } from '../src/types.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('resolveConfig', () => {
  let cwd: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-'));
    delete process.env.PATCHSTACK_SITE_UUID;
    delete process.env.PATCHSTACK_ENDPOINT;
    delete process.env.PATCHSTACK_TIMEOUT_MS;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(cwd, { recursive: true, force: true });
  });

  it('reads the file', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID });
    const config = await resolveConfig({ cwd });
    expect(config.siteUuid).toBe(VALID_UUID);
    expect(config.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('lets env override file', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID });
    process.env.PATCHSTACK_SITE_UUID = '11111111-1111-1111-1111-111111111111';
    const config = await resolveConfig({ cwd });
    expect(config.siteUuid).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('lets cli arg override env', async () => {
    process.env.PATCHSTACK_SITE_UUID = '11111111-1111-1111-1111-111111111111';
    const config = await resolveConfig({ cwd, cliSiteUuid: VALID_UUID });
    expect(config.siteUuid).toBe(VALID_UUID);
  });

  it('throws CONFIG_MISSING when nothing is set', async () => {
    await expect(resolveConfig({ cwd })).rejects.toMatchObject({
      code: 'CONFIG_MISSING',
    });
  });

  it('throws on invalid UUID', async () => {
    await expect(resolveConfig({ cwd, cliSiteUuid: 'not-a-uuid' })).rejects.toBeInstanceOf(
      PatchstackError,
    );
  });

  it('throws CONFIG_INVALID when the file contains malformed JSON', async () => {
    await writeFile(path.join(cwd, '.patchstackrc.json'), '{ this is not json', 'utf8');
    await expect(resolveConfig({ cwd, cliSiteUuid: VALID_UUID })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('reads PATCHSTACK_TIMEOUT_MS from the environment', async () => {
    process.env.PATCHSTACK_TIMEOUT_MS = '5000';
    const config = await resolveConfig({ cwd, cliSiteUuid: VALID_UUID });
    expect(config.timeoutMs).toBe(5000);
  });

  it('throws CONFIG_INVALID when PATCHSTACK_TIMEOUT_MS is not a positive number', async () => {
    process.env.PATCHSTACK_TIMEOUT_MS = 'not-a-number';
    await expect(resolveConfig({ cwd, cliSiteUuid: VALID_UUID })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
});
