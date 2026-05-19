import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractName,
  parseYarnLockfile,
  splitDescriptors,
} from '../src/parsers/yarn.js';
import { detectLockfile, scanLockfile } from '../src/parsers/index.js';
import { PatchstackError } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const v1Project = path.join(fixtures, 'yarn-v1-project');
const berryProject = path.join(fixtures, 'yarn-berry-project');

describe('extractName', () => {
  it('parses plain descriptor', () => {
    expect(extractName('axios@^1.6.0')).toBe('axios');
  });

  it('parses quoted scoped descriptor', () => {
    expect(extractName('"@scope/pkg@^2.1.0"')).toBe('@scope/pkg');
  });

  it('parses yarn berry descriptor with protocol', () => {
    expect(extractName('"@scope/pkg@npm:2.1.0"')).toBe('@scope/pkg');
    expect(extractName('"axios@npm:^1.6.0"')).toBe('axios');
  });

  it('returns null for inputs without a separator', () => {
    expect(extractName('')).toBeNull();
    expect(extractName('bare-name')).toBeNull();
    expect(extractName('@scope/no-version')).toBeNull();
  });
});

describe('splitDescriptors', () => {
  it('splits unquoted descriptors', () => {
    expect(splitDescriptors('axios@^1.6.0, axios@~1.6.0')).toEqual([
      'axios@^1.6.0',
      'axios@~1.6.0',
    ]);
  });

  it('splits quoted descriptors and preserves quotes', () => {
    expect(splitDescriptors('"axios@^1.6.0", "axios@~1.6.0"')).toEqual([
      '"axios@^1.6.0"',
      '"axios@~1.6.0"',
    ]);
  });

  it('treats commas inside quoted strings as literal', () => {
    expect(splitDescriptors('"weird@>=1, <2", normal@^3')).toEqual([
      '"weird@>=1, <2"',
      'normal@^3',
    ]);
  });
});

describe('parseYarnLockfile (v1)', () => {
  it('extracts every resolved package', async () => {
    const entries = await parseYarnLockfile(path.join(v1Project, 'yarn.lock'));
    const names = entries.map((e) => `${e.name}@${e.version}`).sort();
    expect(names).toEqual(
      [
        '@scope/pkg@2.1.0',
        'axios@1.6.0',
        'follow-redirects@1.15.3',
        'lodash@4.17.15',
        'lodash@4.17.21',
        'react@18.2.0',
        'react-dom@18.2.0',
      ].sort(),
    );
  });

  it('preserves both versions of a duplicated package', async () => {
    const entries = await parseYarnLockfile(path.join(v1Project, 'yarn.lock'));
    const lodashes = entries.filter((e) => e.name === 'lodash');
    expect(lodashes.map((l) => l.version).sort()).toEqual(['4.17.15', '4.17.21']);
  });

  it('marks names from package.json dependencies/devDependencies as direct', async () => {
    const entries = await parseYarnLockfile(path.join(v1Project, 'yarn.lock'));
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get('axios')?.direct).toBe(true);
    expect(byName.get('@scope/pkg')?.direct).toBe(true);
    expect(byName.get('react')?.direct).toBe(true);
    expect(byName.get('react-dom')?.direct).toBe(true);
    expect(byName.get('follow-redirects')?.direct).toBe(false);
  });

  it('deduplicates multi-descriptor blocks to a single entry', async () => {
    const entries = await parseYarnLockfile(path.join(v1Project, 'yarn.lock'));
    const axios = entries.filter((e) => e.name === 'axios');
    expect(axios).toHaveLength(1);
    expect(axios[0]?.version).toBe('1.6.0');
  });
});

describe('parseYarnLockfile (berry)', () => {
  it('parses berry-format blocks and skips __metadata', async () => {
    const entries = await parseYarnLockfile(path.join(berryProject, 'yarn.lock'));
    const names = entries.map((e) => `${e.name}@${e.version}`).sort();
    expect(names).toEqual(
      [
        '@scope/pkg@2.1.0',
        'axios@1.6.0',
        'follow-redirects@1.15.3',
        'react@18.2.0',
        'react-dom@18.2.0',
        'vitest@3.0.0',
      ].sort(),
    );
    // The `version: 6` inside __metadata must never leak in as a package.
    expect(entries.find((e) => e.version === '6')).toBeUndefined();
  });

  it('marks direct deps from package.json', async () => {
    const entries = await parseYarnLockfile(path.join(berryProject, 'yarn.lock'));
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get('axios')?.direct).toBe(true);
    expect(byName.get('vitest')?.direct).toBe(true);
    expect(byName.get('react')?.direct).toBe(false);
    expect(byName.get('follow-redirects')?.direct).toBe(false);
  });
});

describe('parseYarnLockfile errors', () => {
  it('throws LOCKFILE_NOT_FOUND when the file is missing', async () => {
    await expect(parseYarnLockfile('/nonexistent/yarn.lock')).rejects.toBeInstanceOf(
      PatchstackError,
    );
  });

  it('throws LOCKFILE_PARSE_ERROR when no package blocks are present', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-yarn-empty-'));
    try {
      const file = path.join(dir, 'yarn.lock');
      await writeFile(file, '# yarn lockfile v1\n');
      await expect(parseYarnLockfile(file)).rejects.toMatchObject({
        code: 'LOCKFILE_PARSE_ERROR',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves direct unset when package.json is absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-yarn-no-pkg-'));
    try {
      await copyFile(path.join(v1Project, 'yarn.lock'), path.join(dir, 'yarn.lock'));
      const entries = await parseYarnLockfile(path.join(dir, 'yarn.lock'));
      for (const e of entries) {
        expect(e.direct).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('detectLockfile for yarn', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-yarn-detect-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('detects yarn.lock and routes to the yarn parser', async () => {
    await copyFile(path.join(v1Project, 'yarn.lock'), path.join(cwd, 'yarn.lock'));
    const detected = await detectLockfile(cwd);
    expect(detected.filename).toBe('yarn.lock');
    expect(detected.strategy).toBe('yarn-lockfile');
    expect(detected.ecosystem).toBe('npm');
  });

  it('prefers package-lock.json over yarn.lock when both exist', async () => {
    await copyFile(
      path.join(fixtures, 'package-lock-v3.json'),
      path.join(cwd, 'package-lock.json'),
    );
    await copyFile(path.join(v1Project, 'yarn.lock'), path.join(cwd, 'yarn.lock'));
    const detected = await detectLockfile(cwd);
    expect(detected.filename).toBe('package-lock.json');
  });

  it('prefers pnpm-lock.yaml over yarn.lock when both exist', async () => {
    await copyFile(
      path.join(fixtures, 'pnpm-lock-v9.yaml'),
      path.join(cwd, 'pnpm-lock.yaml'),
    );
    await copyFile(path.join(v1Project, 'yarn.lock'), path.join(cwd, 'yarn.lock'));
    const detected = await detectLockfile(cwd);
    expect(detected.filename).toBe('pnpm-lock.yaml');
  });
});

describe('scanLockfile for yarn', () => {
  it('returns an npm-ecosystem manifest from a yarn v1 project', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-yarn-scan-'));
    try {
      await copyFile(path.join(v1Project, 'yarn.lock'), path.join(cwd, 'yarn.lock'));
      await copyFile(
        path.join(v1Project, 'package.json'),
        path.join(cwd, 'package.json'),
      );
      const manifest = await scanLockfile(cwd);
      expect(manifest.ecosystem).toBe('npm');
      expect(manifest.packages.find((p) => p.name === 'axios')).toBeDefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns an npm-ecosystem manifest from a yarn berry project', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-yarn-scan-berry-'));
    try {
      await mkdir(cwd, { recursive: true });
      await copyFile(path.join(berryProject, 'yarn.lock'), path.join(cwd, 'yarn.lock'));
      await copyFile(
        path.join(berryProject, 'package.json'),
        path.join(cwd, 'package.json'),
      );
      const manifest = await scanLockfile(cwd);
      expect(manifest.ecosystem).toBe('npm');
      expect(manifest.packages.find((p) => p.name === 'vitest')).toBeDefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
