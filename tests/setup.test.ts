import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { wireBuildScripts } from '../src/setup.js';

describe('wireBuildScripts', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-setup-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function writePackage(value: unknown): void {
    writeFileSync(path.join(cwd, 'package.json'), `${JSON.stringify(value, null, 2)}\n`);
  }

  function readPackage(): { scripts: Record<string, string> } {
    return JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
  }

  it('adds lifecycle hooks for npm without replacing existing hooks', () => {
    writePackage({
      scripts: { build: 'vite build', prebuild: 'npm run lint', postbuild: 'echo complete' },
    });

    const result = wireBuildScripts(cwd, 'npm');

    expect(result).toMatchObject({ changed: true, strategy: 'lifecycle-hooks' });
    expect(readPackage().scripts).toMatchObject({
      build: 'vite build',
      prebuild: 'npm run lint && patchstack-connect scan',
      postbuild: 'echo complete && patchstack-connect mark-build',
    });
  });

  it('chains directly around a Bun build', () => {
    writePackage({ scripts: { build: 'vite build' } });

    const result = wireBuildScripts(cwd, 'bun');

    expect(result).toMatchObject({ changed: true, strategy: 'build-chain' });
    expect(readPackage().scripts.build).toBe(
      'patchstack-connect scan && vite build && patchstack-connect mark-build',
    );
  });

  it('is idempotent', () => {
    writePackage({ scripts: { build: 'vite build' } });

    wireBuildScripts(cwd, 'pnpm');
    const second = wireBuildScripts(cwd, 'pnpm');

    expect(second.changed).toBe(false);
    expect(readPackage().scripts.prebuild).toBe('patchstack-connect scan');
    expect(readPackage().scripts.postbuild).toBe('patchstack-connect mark-build');
  });

  it('does not add inert hooks when no build script exists', () => {
    writePackage({ scripts: { test: 'vitest' } });

    const before = readFileSync(path.join(cwd, 'package.json'), 'utf8');
    const result = wireBuildScripts(cwd, 'npm');

    expect(result).toMatchObject({ changed: false, strategy: 'skipped' });
    expect(readFileSync(path.join(cwd, 'package.json'), 'utf8')).toBe(before);
  });

  it('creates a scripts object when necessary but still requires a build command', () => {
    writePackage({ name: 'no-scripts' });
    mkdirSync(path.join(cwd, 'src'));

    const result = wireBuildScripts(cwd, 'yarn');

    expect(result.strategy).toBe('skipped');
  });
});
