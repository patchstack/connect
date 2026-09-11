import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureProjectDirectorySync, writeProjectFileSync } from '../src/safe-file.js';

const roots: string[] = [];
const temporaryProject = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'connect-files-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('managed project files', () => {
  it.skipIf(process.platform === 'win32')('replaces files atomically and preserves their mode', () => {
    const cwd = temporaryProject();
    const target = join(cwd, 'settings.json');
    writeFileSync(target, 'before');
    chmodSync(target, 0o640);

    writeProjectFileSync(cwd, target, 'after', { encoding: 'utf8' });

    expect(readFileSync(target, 'utf8')).toBe('after');
    expect(statSync(target).mode & 0o777).toBe(0o640);
    expect(readdirSync(cwd)).toEqual(['settings.json']);
  });

  it('does not follow a linked destination', () => {
    const cwd = temporaryProject();
    const outside = join(temporaryProject(), 'outside.txt');
    writeFileSync(outside, 'outside');
    const target = join(cwd, 'settings.json');
    symlinkSync(outside, target);

    expect(() => writeProjectFileSync(cwd, target, 'replacement')).toThrow(/symbolic link/);
    expect(readFileSync(outside, 'utf8')).toBe('outside');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it('does not create files through a linked project directory', () => {
    const cwd = temporaryProject();
    const outside = temporaryProject();
    symlinkSync(outside, join(cwd, 'generated'), 'dir');

    expect(() => ensureProjectDirectorySync(cwd, join(cwd, 'generated', 'nested'))).toThrow(/symbolic link/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('rejects paths outside the selected project', () => {
    const cwd = temporaryProject();
    const outside = join(temporaryProject(), 'outside.txt');

    expect(() => writeProjectFileSync(cwd, outside, 'replacement')).toThrow(/outside the project/);
  });

  it('creates ordinary nested project directories', () => {
    const cwd = temporaryProject();
    const nested = join(cwd, 'generated', 'nested');
    expect(ensureProjectDirectorySync(cwd, nested)).toBe(realpathSync(nested));
    expect(statSync(nested).isDirectory()).toBe(true);
  });
});
