import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePackageKey, parsePnpmLockfile } from '../src/parsers/pnpm.js';
import { detectLockfile, scanLockfile } from '../src/parsers/index.js';
import { PatchstackError } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const v9Fixture = path.join(fixtures, 'pnpm-lock-v9.yaml');
const v6Fixture = path.join(fixtures, 'pnpm-lock-v6.yaml');

describe('parsePackageKey', () => {
  it('parses plain v9 keys', () => {
    expect(parsePackageKey('axios@1.6.0')).toEqual({ name: 'axios', version: '1.6.0' });
  });

  it('parses scoped v9 keys', () => {
    expect(parsePackageKey('@scope/pkg@2.1.0')).toEqual({
      name: '@scope/pkg',
      version: '2.1.0',
    });
  });

  it('strips v6 leading slash', () => {
    expect(parsePackageKey('/axios@1.6.0')).toEqual({ name: 'axios', version: '1.6.0' });
    expect(parsePackageKey('/@scope/pkg@2.1.0')).toEqual({
      name: '@scope/pkg',
      version: '2.1.0',
    });
  });

  it('strips v6+ peer suffix', () => {
    expect(parsePackageKey('react-dom@18.2.0(react@18.2.0)')).toEqual({
      name: 'react-dom',
      version: '18.2.0',
    });
    expect(parsePackageKey("'react-dom@18.2.0(react@18.2.0)(other@2)'")).toEqual({
      name: 'react-dom',
      version: '18.2.0',
    });
  });

  it('parses v5 slash-separated keys', () => {
    expect(parsePackageKey('/axios/1.6.0')).toEqual({ name: 'axios', version: '1.6.0' });
    expect(parsePackageKey('/@scope/pkg/2.1.0')).toEqual({
      name: '@scope/pkg',
      version: '2.1.0',
    });
  });

  it('strips v5 underscore peer suffix', () => {
    expect(parsePackageKey('/react-dom/18.2.0_react@18.2.0')).toEqual({
      name: 'react-dom',
      version: '18.2.0',
    });
  });

  it('returns null for unparseable input', () => {
    expect(parsePackageKey('')).toBeNull();
    expect(parsePackageKey('bare-name')).toBeNull();
  });
});

describe('parsePnpmLockfile (v9)', () => {
  it('extracts every package from the packages: block', async () => {
    const entries = await parsePnpmLockfile(v9Fixture);
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
  });

  it('marks importers.dependencies and devDependencies as direct', async () => {
    const entries = await parsePnpmLockfile(v9Fixture);
    const byName = new Map(entries.map((e) => [e.name, e]));

    expect(byName.get('axios')?.direct).toBe(true);
    expect(byName.get('@scope/pkg')?.direct).toBe(true);
    expect(byName.get('react-dom')?.direct).toBe(true);
    expect(byName.get('vitest')?.direct).toBe(true);
    expect(byName.get('follow-redirects')?.direct).toBe(false);
    expect(byName.get('react')?.direct).toBe(false);
  });

  it('deduplicates peer-suffixed keys to a single entry', async () => {
    const entries = await parsePnpmLockfile(v9Fixture);
    const reactDom = entries.filter((e) => e.name === 'react-dom');
    expect(reactDom).toHaveLength(1);
    expect(reactDom[0]?.version).toBe('18.2.0');
  });
});

describe('parsePnpmLockfile (v6)', () => {
  it('parses leading-slash keys and top-level direct deps', async () => {
    const entries = await parsePnpmLockfile(v6Fixture);
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

    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get('axios')?.direct).toBe(true);
    expect(byName.get('vitest')?.direct).toBe(true);
    expect(byName.get('follow-redirects')?.direct).toBe(false);
  });
});

describe('parsePnpmLockfile errors', () => {
  it('throws LOCKFILE_NOT_FOUND when the file is missing', async () => {
    await expect(parsePnpmLockfile('/nonexistent/pnpm-lock.yaml')).rejects.toBeInstanceOf(
      PatchstackError,
    );
  });

  it('throws LOCKFILE_PARSE_ERROR when the packages block is empty', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-pnpm-empty-'));
    try {
      const file = path.join(dir, 'pnpm-lock.yaml');
      await writeFile(file, "lockfileVersion: '9.0'\n");
      await expect(parsePnpmLockfile(file)).rejects.toMatchObject({
        code: 'LOCKFILE_PARSE_ERROR',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('detectLockfile for pnpm', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-pnpm-detect-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('detects pnpm-lock.yaml and routes to the pnpm parser', async () => {
    await copyFile(v9Fixture, path.join(cwd, 'pnpm-lock.yaml'));
    const detected = await detectLockfile(cwd);
    expect(detected.filename).toBe('pnpm-lock.yaml');
    expect(detected.strategy).toBe('pnpm-lockfile');
    expect(detected.ecosystem).toBe('npm');
  });

  it('prefers package-lock.json over pnpm-lock.yaml when both exist', async () => {
    await copyFile(
      path.join(fixtures, 'package-lock-v3.json'),
      path.join(cwd, 'package-lock.json'),
    );
    await copyFile(v9Fixture, path.join(cwd, 'pnpm-lock.yaml'));
    const detected = await detectLockfile(cwd);
    expect(detected.filename).toBe('package-lock.json');
  });
});

describe('scanLockfile for pnpm', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-pnpm-scan-'));
    await copyFile(v9Fixture, path.join(cwd, 'pnpm-lock.yaml'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('returns an npm-ecosystem manifest', async () => {
    const manifest = await scanLockfile(cwd);
    expect(manifest.ecosystem).toBe('npm');
    expect(manifest.packages.length).toBeGreaterThan(0);
    expect(manifest.packages.find((p) => p.name === 'axios')).toBeDefined();
  });
});
