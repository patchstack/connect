import { describe, expect, it } from 'vitest';

import { buildManifestBody } from '../src/client.js';
import { reportTrigger } from '../src/report-context.js';
import type { Config } from '../src/types.js';

const config = {
  siteUuid: '550e8400-e29b-41d4-a716-446655440000',
  endpoint: 'https://example.com/monitor/pulse/manifest',
  timeoutMs: 30_000,
  environment: 'local',
} as unknown as Config;

const payload = { packages: [{ name: 'lodash', version: '4.17.21' }] } as Parameters<typeof buildManifestBody>[1];

describe('reportTrigger', () => {
  it.each(['preinstall', 'install', 'postinstall', 'prepare'])('reads %s as an install', (event) => {
    expect(reportTrigger({ npm_lifecycle_event: event })).toBe('install');
  });

  it.each(['prebuild', 'build', 'postbuild'])('reads %s as a build', (event) => {
    expect(reportTrigger({ npm_lifecycle_event: event })).toBe('build');
  });

  it('reads a direct run or any other script as other', () => {
    expect(reportTrigger({})).toBe('other');
    expect(reportTrigger({ npm_lifecycle_event: 'npx' })).toBe('other');
    expect(reportTrigger({ npm_lifecycle_event: 'dev' })).toBe('other');
  });
});

describe('buildManifestBody report context', () => {
  it('names the trigger', () => {
    expect(buildManifestBody(config, payload, { npm_lifecycle_event: 'postinstall' }).trigger).toBe('install');
    expect(buildManifestBody(config, payload, { npm_lifecycle_event: 'build' }).trigger).toBe('build');
  });

  it('always sends a trigger, even when nothing names one', () => {
    expect(buildManifestBody(config, payload, {}).trigger).toBe('other');
  });
});
