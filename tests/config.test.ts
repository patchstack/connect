import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { persistApiKey, persistSiteUuid, resolveConfig, writeConfigFile } from '../src/config.js';
import { readFile } from 'node:fs/promises';
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
    delete process.env.PATCHSTACK_ENVIRONMENT;
    delete process.env.PATCHSTACK_SITE_URL;
    // The build-environment variables the site URL is inferred from, so a developer's own shell (or a
    // CI runner that happens to be one of these platforms) cannot decide what these tests see.
    for (const key of [
      'VERCEL_ENV',
      'VERCEL_PROJECT_PRODUCTION_URL',
      'NETLIFY',
      'CONTEXT',
      'URL',
      'RENDER',
      'RENDER_EXTERNAL_URL',
      'IS_PULL_REQUEST',
      'RAILWAY_ENVIRONMENT_NAME',
      'RAILWAY_PUBLIC_DOMAIN',
    ]) {
      delete process.env[key];
    }
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

  it('returns siteUuid null when nothing is set', async () => {
    const config = await resolveConfig({ cwd });
    expect(config.siteUuid).toBeNull();
    expect(config.endpoint).toBe(DEFAULT_ENDPOINT);
  });

  it('still throws CONFIG_MISSING when requireSiteUuid is true', async () => {
    await expect(resolveConfig({ cwd, requireSiteUuid: true })).rejects.toMatchObject({
      code: 'CONFIG_MISSING',
    });
  });

  it('persistSiteUuid merges into existing config and preserves other fields', async () => {
    await writeConfigFile(cwd, { endpoint: 'https://custom.example.com/monitor/pulse/manifest' });
    await persistSiteUuid(cwd, VALID_UUID);
    const raw = await readFile(path.join(cwd, '.patchstackrc.json'), 'utf8');
    const parsed = JSON.parse(raw) as { siteUuid?: string; endpoint?: string };
    expect(parsed.siteUuid).toBe(VALID_UUID);
    expect(parsed.endpoint).toBe('https://custom.example.com/monitor/pulse/manifest');
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

  it('defaults the environment to production', async () => {
    const config = await resolveConfig({ cwd, cliSiteUuid: VALID_UUID });
    expect(config.environment).toBe('production');
  });

  it('reads PATCHSTACK_ENVIRONMENT from the environment', async () => {
    process.env.PATCHSTACK_ENVIRONMENT = 'sandbox';
    const config = await resolveConfig({ cwd, cliSiteUuid: VALID_UUID });
    expect(config.environment).toBe('sandbox');
  });

  it('reads environment from the config file', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, environment: 'sandbox' });
    const config = await resolveConfig({ cwd });
    expect(config.environment).toBe('sandbox');
  });

  it('lets PATCHSTACK_ENVIRONMENT override the file', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, environment: 'sandbox' });
    process.env.PATCHSTACK_ENVIRONMENT = 'production';
    const config = await resolveConfig({ cwd });
    expect(config.environment).toBe('production');
  });

  it('throws CONFIG_INVALID when the environment is not production or sandbox', async () => {
    process.env.PATCHSTACK_ENVIRONMENT = 'staging';
    await expect(resolveConfig({ cwd, cliSiteUuid: VALID_UUID })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
});

/**
 * One credential authenticates Pulse ingest and block-log reporting. These pin
 * the two things that must stay true for configs written by earlier versions.
 */
describe('credential resolution', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-'));
    delete process.env.PATCHSTACK_API_KEY;
    delete process.env.PATCHSTACK_PULSE_AUTH;
  });

  afterEach(() => rm(cwd, { recursive: true, force: true }));

  it('uses apiKey for Pulse when no pulseAuth is present', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, apiKey: 'secret-987' });

    const config = await resolveConfig({ cwd });

    expect(config.apiKey).toBe('secret-987');
    expect(config.pulseAuth).toBe('secret-987');
  });

  it('still honours a pulseAuth written by an earlier version', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, apiKey: 'a-1', pulseAuth: 'b-2' });

    expect((await resolveConfig({ cwd })).pulseAuth).toBe('b-2');
  });

  it('drops a stale pulseAuth when the credential is replaced', async () => {
    // pulseAuth resolves ahead of apiKey, so a leftover copy would keep
    // authenticating Pulse with the value the server just replaced.
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, apiKey: 'old-1', pulseAuth: 'old-1' });

    await persistApiKey(cwd, 'rotated-2');

    const config = await resolveConfig({ cwd });
    expect(config.apiKey).toBe('rotated-2');
    expect(config.pulseAuth).toBe('rotated-2');
    expect(JSON.parse(await readFile(path.join(cwd, '.patchstackrc.json'), 'utf8')).pulseAuth).toBeUndefined();
  });

  it('lets PATCHSTACK_PULSE_AUTH override the file', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, apiKey: 'file-1' });
    process.env.PATCHSTACK_PULSE_AUTH = 'env-2';

    expect((await resolveConfig({ cwd })).pulseAuth).toBe('env-2');
  });
});

describe('resolveConfig: where the app is published', () => {
  let cwd: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-url-'));
    delete process.env.PATCHSTACK_SITE_URL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(cwd, { recursive: true, force: true });
  });

  it('reports nothing from a laptop build', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID });
    const config = await resolveConfig({ cwd });
    expect(config.siteUrl).toBeNull();
  });

  it('reads an explicit url from the committed config', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, url: 'https://shop.example.com/home' });
    const config = await resolveConfig({ cwd });
    expect(config.siteUrl).toBe('https://shop.example.com');
  });

  it('infers the production url from the build environment', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID });
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'shop.example.com';

    const config = await resolveConfig({ cwd });
    expect(config.siteUrl).toBe('https://shop.example.com');
  });

  it('prefers what a person configured over what the build environment reports', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, url: 'https://www.example.com' });
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'shop-abc.vercel.app';

    const config = await resolveConfig({ cwd });
    expect(config.siteUrl).toBe('https://www.example.com');
  });

  it('lets the environment variable override the committed config', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, url: 'https://old.example.com' });
    process.env.PATCHSTACK_SITE_URL = 'https://new.example.com';

    const config = await resolveConfig({ cwd });
    expect(config.siteUrl).toBe('https://new.example.com');
  });

  it('falls through to the build environment when the configured url is unusable', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, url: 'http://localhost:3000' });
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'shop.example.com';

    const config = await resolveConfig({ cwd });
    expect(config.siteUrl).toBe('https://shop.example.com');
  });
});
