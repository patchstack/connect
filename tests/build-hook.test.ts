import { describe, expect, it } from 'vitest';
import { isInstallOrBuildHook, undeliveredReportLines } from '../src/build-hook.js';
import { PatchstackError, type Config } from '../src/types.js';

/**
 * A hooked `scan` must not fail the build it is attached to, and must say why the report did not land.
 *
 * The hook is recognised by the lifecycle name the package manager exports, so these pin which names
 * count: the ones `setup` wires and their neighbours, and none of the names a person or an assistant
 * produces by running the command directly. The messages are pinned because the error's own remedy —
 * run `login` — is the wrong one in a build environment, and that text is what the build log shows.
 */
describe('isInstallOrBuildHook', () => {
  it('recognises the install and build lifecycle names', () => {
    for (const event of ['preinstall', 'install', 'postinstall', 'prepare', 'prebuild', 'build', 'postbuild']) {
      expect(isInstallOrBuildHook({ npm_lifecycle_event: event })).toBe(true);
    }
  });

  it('does not recognise a direct invocation', () => {
    // `npx` names its event `npx`, `bun <bin>` names it after the bin, a project script after itself, and a
    // bare `node` sets nothing.
    for (const event of ['npx', 'patchstack-connect', 'scan', 'dev', 'start', 'test', '']) {
      expect(isInstallOrBuildHook({ npm_lifecycle_event: event })).toBe(false);
    }
    expect(isInstallOrBuildHook({})).toBe(false);
  });
});

describe('undeliveredReportLines', () => {
  const config = (over: Partial<Config> = {}): Config => ({
    siteUuid: '11111111-1111-4111-8111-111111111111',
    apiKey: null,
    pulseAuth: null,
    endpoint: 'https://api.test/monitor/pulse/manifest',
    timeoutMs: 5_000,
    environment: 'production',
    widget: true,
    ...over,
  });

  it('points a build environment with no credential at the env var, not at login', () => {
    const said = undeliveredReportLines(new PatchstackError('none configured', 'UNAUTHORIZED'), config(), '/srv/app').join('\n');

    expect(said).toContain('none configured');
    expect(said).toContain('PATCHSTACK_API_KEY');
    expect(said).toContain('continuing the build');
  });

  it('names every source it checked, and where, when no credential was found', () => {
    // The question a build log has to settle is whether the file was read at all. Naming both files and
    // the directory is what turns "none is configured" into an answer.
    const said = undeliveredReportLines(new PatchstackError('none configured', 'UNAUTHORIZED'), config(), '/srv/app').join('\n');

    expect(said).toContain('.patchstackrc.local.json');
    expect(said).toContain('.patchstackrc.json');
    expect(said).toContain('/srv/app');
    expect(said).toContain('git-ignored');
  });

  it('says a held credential was rejected rather than missing', () => {
    const held = config({ apiKey: 'a-secret', pulseAuth: 'a-secret' });
    const said = undeliveredReportLines(new PatchstackError('rejected', 'UNAUTHORIZED'), held, '/srv/app').join('\n');

    expect(said).toContain('rejected');
    expect(said).toContain('PATCHSTACK_API_KEY');
    expect(said).not.toContain('never has');
    expect(said).not.toContain('/srv/app');
  });

  it('adds no credential advice to a failure that is not about credentials', () => {
    // The control: a network failure with credential advice attached would send someone to set a variable
    // that changes nothing.
    for (const code of ['NETWORK_ERROR', 'NETWORK_TIMEOUT', 'SERVER_ERROR', 'SITE_NOT_FOUND', 'VALIDATION_ERROR'] as const) {
      const lines = undeliveredReportLines(new PatchstackError(`failed: ${code}`, code), config(), '/srv/app');

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain(`failed: ${code}`);
      expect(lines.join('\n')).not.toContain('PATCHSTACK_API_KEY');
      expect(lines[1]).toContain('continuing the build');
    }
  });

  it('never prints the credential itself', () => {
    const held = config({ apiKey: 'the-secret-value-0001', pulseAuth: 'the-secret-value-0001' });
    const said = undeliveredReportLines(new PatchstackError('rejected', 'UNAUTHORIZED'), held, '/srv/app').join('\n');

    expect(said).not.toContain('the-secret-value-0001');
  });
});
