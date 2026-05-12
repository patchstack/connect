import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNpmLockfile } from '../src/parsers/npm.js';
import { detectLockfile, scanLockfile } from '../src/parsers/index.js';
import { PatchstackError } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');

describe('parseNpmLockfile (v3)', () => {
  it('extracts every package with a version', async () => {
    const entries = await parseNpmLockfile(path.join(fixtures, 'package-lock-v3.json'));
    const names = entries.map((e) => `${e.name}@${e.version}`).sort();
    expect(names).toEqual(
      [
        '@scope/pkg@2.1.0',
        'axios@1.6.0',
        'follow-redirects@1.15.3',
        'lodash@4.17.15',
        'lodash@4.17.21',
      ].sort(),
    );
  });

  it('preserves both versions of a duplicated package', async () => {
    const entries = await parseNpmLockfile(path.join(fixtures, 'package-lock-v3.json'));
    const lodashes = entries.filter((e) => e.name === 'lodash');
    expect(lodashes).toHaveLength(2);
    expect(lodashes.map((l) => l.version).sort()).toEqual(['4.17.15', '4.17.21']);
  });

  it('marks direct dependencies and skips workspace links', async () => {
    const entries = await parseNpmLockfile(path.join(fixtures, 'package-lock-v3.json'));
    const axios = entries.find((e) => e.name === 'axios');
    expect(axios?.direct).toBe(true);

    const nested = entries.find((e) => e.version === '4.17.15');
    expect(nested?.direct).toBe(false);

    expect(entries.find((e) => e.name === 'linked-workspace')).toBeUndefined();
  });

  it('handles scoped package names', async () => {
    const entries = await parseNpmLockfile(path.join(fixtures, 'package-lock-v3.json'));
    const scoped = entries.find((e) => e.name === '@scope/pkg');
    expect(scoped).toBeDefined();
    expect(scoped?.version).toBe('2.1.0');
  });
});

describe('parseNpmLockfile (v1)', () => {
  it('walks nested dependencies', async () => {
    const entries = await parseNpmLockfile(path.join(fixtures, 'package-lock-v1.json'));
    const map = Object.fromEntries(entries.map((e) => [e.name, e.version]));
    expect(map['axios']).toBe('0.21.0');
    expect(map['follow-redirects']).toBe('1.13.0');
    expect(map['lodash']).toBe('4.17.10');
  });
});

describe('detectLockfile', () => {
  it('throws LOCKFILE_NOT_FOUND in an empty cwd', async () => {
    const empty = path.join(fixtures, 'nonexistent-directory-xyz');
    await expect(detectLockfile(empty)).rejects.toBeInstanceOf(PatchstackError);
  });
});

describe('scanLockfile', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-scan-'));
    await copyFile(
      path.join(fixtures, 'package-lock-v3.json'),
      path.join(cwd, 'package-lock.json'),
    );
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('returns an npm manifest from a directory with a package-lock.json', async () => {
    const manifest = await scanLockfile(cwd);
    expect(manifest.ecosystem).toBe('npm');
    expect(manifest.packages.length).toBeGreaterThan(0);
  });
});
