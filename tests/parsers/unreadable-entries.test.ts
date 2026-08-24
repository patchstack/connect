import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanLockfile } from '../../src/parsers/index.js';
import { parseYarnLockfile } from '../../src/parsers/yarn.js';
import { parsePnpmLockfile } from '../../src/parsers/pnpm.js';
import { newReport } from '../../src/parsers/report.js';

/**
 * What a hand-written scanner says about the entries it could not read.
 *
 * Skipping an entry it does not recognise is right — a made-up name and version would put something in a
 * vulnerability inventory that no advisory can match. Skipping it without saying so is not: the manifest
 * then reads as the whole dependency set, and a dropped package is indistinguishable from one that is not
 * installed.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-unreadable-'));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);

  return dir;
}

const PACKAGE_JSON = JSON.stringify({ name: 'fixture', dependencies: { lodash: '^4.17.21' } });

describe('a yarn.lock entry this scanner does not read', () => {
  it('is counted and named', async () => {
    const report = newReport();
    const dir = project({
      'package.json': PACKAGE_JSON,
      'yarn.lock': [
        '__metadata:',
        '  version: 8',
        '',
        'lodash@npm:^4.17.21:',
        '  version: 4.17.21',
        '',
        'something-unfamiliar:',
        '  version: 2.0.0',
        '',
      ].join('\n'),
    });

    const packages = await parseYarnLockfile(join(dir, 'yarn.lock'), report);

    expect(packages.map((p) => p.name)).toEqual(['lodash']);
    expect(report.unreadable).toBe(1);
    expect(report.samples).toEqual(['something-unfamiliar']);
  });

  it('does not include an entry left out on purpose', async () => {
    // A workspace root and the berry header are not packages and are not meant to become one. Counted as
    // unreadable they would put a warning on every Berry project, which is a warning nobody reads.
    const report = newReport();
    const dir = project({
      'package.json': PACKAGE_JSON,
      'yarn.lock': [
        '__metadata:',
        '  version: 8',
        '',
        '"fixture@workspace:.":',
        '  version: 0.0.0-use.local',
        '',
        '"local-thing@file:./vendor/local-thing":',
        '  version: 1.0.0',
        '',
        'lodash@npm:^4.17.21:',
        '  version: 4.17.21',
        '',
      ].join('\n'),
    });

    await parseYarnLockfile(join(dir, 'yarn.lock'), report);

    expect(report.unreadable).toBe(0);
  });

  it('reaches the manifest as a warning', async () => {
    const dir = project({
      'package.json': PACKAGE_JSON,
      'yarn.lock': [
        'lodash@npm:^4.17.21:',
        '  version: 4.17.21',
        '',
        'something-unfamiliar:',
        '  version: 2.0.0',
        '',
      ].join('\n'),
    });

    const manifest = await scanLockfile(dir);

    expect(manifest.warnings?.join(' ')).toContain('something-unfamiliar');
    expect(manifest.warnings?.join(' ')).toContain('not being checked');
  });

  it('leaves a fully-read lockfile without a warning', async () => {
    // The control. A warning printed for every project would train people to ignore the one that matters.
    const dir = project({
      'package.json': PACKAGE_JSON,
      'yarn.lock': ['lodash@npm:^4.17.21:', '  version: 4.17.21', ''].join('\n'),
    });

    expect((await scanLockfile(dir)).warnings).toBeUndefined();
  });
});

describe('a pnpm-lock.yaml key this scanner does not read', () => {
  it('is counted rather than dropped in silence', async () => {
    const report = newReport();
    const dir = project({
      'package.json': PACKAGE_JSON,
      'pnpm-lock.yaml': [
        'lockfileVersion: "9.0"',
        '',
        'packages:',
        '',
        '  lodash@4.17.21:',
        '    resolution: {integrity: sha512-x}',
        '',
        '  keywithnoversion:',
        '    resolution: {integrity: sha512-y}',
        '',
      ].join('\n'),
    });

    const packages = await parsePnpmLockfile(join(dir, 'pnpm-lock.yaml'), report);

    expect(packages.map((p) => p.name)).toEqual(['lodash']);
    expect(report.unreadable).toBe(1);
    expect(report.samples).toEqual(['keywithnoversion']);
  });
});
