import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { persistSiteUuid, resolveConfig, writeConfigFile } from '../src/config.js';
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
    expect(config.widgetEnabled).toBe(true);
  });

  it('lets env override file', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID });
    process.env.PATCHSTACK_SITE_UUID = '11111111-1111-1111-1111-111111111111';
    const config = await resolveConfig({ cwd });
    expect(config.siteUuid).toBe('11111111-1111-1111-1111-111111111111');
  });

  it.each(['', '   '])('ignores a blank environment UUID and keeps the file UUID (%j)', async (blank) => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID });
    process.env.PATCHSTACK_SITE_UUID = blank;
    const config = await resolveConfig({ cwd });
    expect(config.siteUuid).toBe(VALID_UUID);
  });

  it('lets cli arg override env', async () => {
    process.env.PATCHSTACK_SITE_UUID = '11111111-1111-1111-1111-111111111111';
    const config = await resolveConfig({ cwd, cliSiteUuid: VALID_UUID });
    expect(config.siteUuid).toBe(VALID_UUID);
  });

  it('ignores a blank endpoint environment override and keeps the file endpoint', async () => {
    const endpoint = 'https://staging.example.com/monitor/pulse/manifest';
    await writeConfigFile(cwd, { endpoint });
    process.env.PATCHSTACK_ENDPOINT = '   ';
    expect((await resolveConfig({ cwd })).endpoint).toBe(endpoint);
  });

  it.each(['not-a-url', 'file:///tmp/manifest', 'https://example.com/x#fragment'])(
    'rejects an invalid endpoint (%s)',
    async (endpoint) => {
      await expect(resolveConfig({ cwd, cliEndpoint: endpoint })).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
    },
  );

  it.each(['', '   '])('rejects a blank explicit CLI UUID (%j)', async (blank) => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID });
    await expect(resolveConfig({ cwd, cliSiteUuid: blank })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
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
    await writeConfigFile(cwd, {
      endpoint: 'https://custom.example.com/monitor/pulse/manifest',
      widget: false,
    });
    await persistSiteUuid(cwd, VALID_UUID);
    const raw = await readFile(path.join(cwd, '.patchstackrc.json'), 'utf8');
    const parsed = JSON.parse(raw) as { siteUuid?: string; endpoint?: string; widget?: boolean };
    expect(parsed.siteUuid).toBe(VALID_UUID);
    expect(parsed.endpoint).toBe('https://custom.example.com/monitor/pulse/manifest');
    expect(parsed.widget).toBe(false);
  });

  it('persists a provisioning endpoint together with its UUID', async () => {
    const endpoint = 'https://staging.example.com/monitor/pulse/manifest';
    await persistSiteUuid(cwd, VALID_UUID, endpoint);
    const parsed = JSON.parse(
      await readFile(path.join(cwd, '.patchstackrc.json'), 'utf8'),
    ) as { siteUuid?: string; endpoint?: string };
    expect(parsed).toMatchObject({ siteUuid: VALID_UUID, endpoint });
  });

  it('persistSiteUuid refuses to replace a different existing UUID', async () => {
    const otherUuid = '11111111-1111-1111-1111-111111111111';
    await writeConfigFile(cwd, {
      siteUuid: VALID_UUID,
      endpoint: 'https://custom.example.com/monitor/pulse/manifest',
      widget: false,
    });
    const before = await readFile(path.join(cwd, '.patchstackrc.json'), 'utf8');

    await expect(persistSiteUuid(cwd, otherUuid)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });

    expect(await readFile(path.join(cwd, '.patchstackrc.json'), 'utf8')).toBe(before);
  });

  it('persistSiteUuid rejects an invalid new UUID before writing', async () => {
    await expect(persistSiteUuid(cwd, 'not-a-uuid')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    await expect(readFile(path.join(cwd, '.patchstackrc.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
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

  it.each([
    ['siteUuid', 123],
    ['endpoint', { url: 'https://example.com' }],
    ['timeoutMs', '5000'],
    ['timeoutMs', 0],
    ['environment', true],
    ['widget', 'yes'],
  ])('throws CONFIG_INVALID when file field %s has invalid value %j', async (field, value) => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      JSON.stringify({ [field]: value }),
      'utf8',
    );
    await expect(resolveConfig({ cwd })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('supports a persisted widget opt-out', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, widget: false });
    const config = await resolveConfig({ cwd });
    expect(config.widgetEnabled).toBe(false);
  });

  it('throws CONFIG_INVALID when the config root is not an object', async () => {
    await writeFile(path.join(cwd, '.patchstackrc.json'), '[]', 'utf8');
    await expect(resolveConfig({ cwd })).rejects.toMatchObject({
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
