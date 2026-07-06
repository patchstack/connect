import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('stale lockfile detection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ps-stale-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeJson(rel: string, value: unknown): Promise<void> {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, JSON.stringify(value, null, 2));
  }

  /** Minimal npm lockfile v3 with the given node_modules packages. */
  function lockfileV3(packages: Record<string, string>): unknown {
    const entries: Record<string, unknown> = {
      '': { name: 'fixture-app', version: '1.0.0' },
    };
    for (const [name, version] of Object.entries(packages)) {
      entries[`node_modules/${name}`] = { version };
    }
    return { name: 'fixture-app', lockfileVersion: 3, packages: entries };
  }

  async function installNodeModules(packages: Record<string, string>): Promise<void> {
    for (const [name, version] of Object.entries(packages)) {
      await writeJson(path.join('node_modules', name, 'package.json'), { name, version });
    }
  }

  it('falls back to the installed truth when package-lock.json misses declared dependencies', async () => {
    // The Lovable failure mode: `npm install` planted a package-lock.json once,
    // then the platform's native (bun) flow added dayjs — updating package.json,
    // bun.lockb and node_modules, but never the npm lockfile. The fossil must
    // not win: scan the source that actually covers the declared dependencies.
    await writeJson('package.json', {
      name: 'fixture-app',
      dependencies: { axios: '^1.6.0', dayjs: '^1.11.0' },
    });
    await writeJson('package-lock.json', lockfileV3({ axios: '1.6.0' }));
    await writeFile(path.join(dir, 'bun.lockb'), 'binary-placeholder');
    await installNodeModules({ axios: '1.6.0', dayjs: '1.11.10' });

    const manifest = await scanLockfile(dir);
    const names = manifest.packages.map((p) => p.name);

    expect(names).toContain('dayjs');
    expect(manifest.warnings?.join(' ')).toMatch(/package-lock\.json.*dayjs/s);
  });

  it('uses node_modules as a last resort even without a bun lockfile', async () => {
    await writeJson('package.json', {
      name: 'fixture-app',
      dependencies: { dayjs: '^1.11.0' },
    });
    await writeJson('package-lock.json', lockfileV3({ axios: '1.6.0' }));
    await installNodeModules({ axios: '1.6.0', dayjs: '1.11.10' });

    const manifest = await scanLockfile(dir);

    expect(manifest.packages.map((p) => p.name)).toContain('dayjs');
    expect(manifest.warnings?.length).toBeGreaterThan(0);
  });

  it('keeps a consistent package-lock.json without warnings', async () => {
    await writeJson('package.json', {
      name: 'fixture-app',
      dependencies: { axios: '^1.6.0' },
      devDependencies: { dayjs: '^1.11.0' },
    });
    await writeJson('package-lock.json', lockfileV3({ axios: '1.6.0', dayjs: '1.11.10' }));
    // node_modules deliberately different: a consistent lockfile stays authoritative.
    await installNodeModules({ axios: '1.6.0' });

    const manifest = await scanLockfile(dir);

    expect(manifest.packages.map((p) => p.name).sort()).toEqual(['axios', 'dayjs']);
    expect(manifest.warnings ?? []).toEqual([]);
  });

  it('ignores non-registry specifiers when judging staleness', async () => {
    await writeJson('package.json', {
      name: 'fixture-app',
      dependencies: {
        axios: '^1.6.0',
        'local-lib': 'file:../local-lib',
        'workspace-lib': 'workspace:*',
      },
    });
    await writeJson('package-lock.json', lockfileV3({ axios: '1.6.0' }));

    const manifest = await scanLockfile(dir);

    expect(manifest.packages.map((p) => p.name)).toEqual(['axios']);
    expect(manifest.warnings ?? []).toEqual([]);
  });

  it('returns the best available source with a warning when nothing is fully consistent', async () => {
    await writeJson('package.json', {
      name: 'fixture-app',
      dependencies: { axios: '^1.6.0', dayjs: '^1.11.0' },
    });
    await writeJson('package-lock.json', lockfileV3({ axios: '1.6.0' }));
    // No node_modules at all: still scan (never fail harder than today), but say so.

    const manifest = await scanLockfile(dir);

    expect(manifest.packages.map((p) => p.name)).toEqual(['axios']);
    expect(manifest.warnings?.length).toBeGreaterThan(0);
  });

  it('behaves exactly as before when there is no package.json to validate against', async () => {
    await writeJson('package-lock.json', lockfileV3({ axios: '1.6.0' }));

    const manifest = await scanLockfile(dir);

    expect(manifest.packages.map((p) => p.name)).toEqual(['axios']);
    expect(manifest.warnings ?? []).toEqual([]);
  });
});
