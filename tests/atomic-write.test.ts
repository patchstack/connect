import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { atomicWriteTextFile } from '../src/atomic-write.js';

describe('atomicWriteTextFile', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-atomic-write-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('creates and replaces a complete text file', async () => {
    const target = path.join(cwd, 'config.json');
    await atomicWriteTextFile(target, '{"first":true}\n');
    expect(await readFile(target, 'utf8')).toBe('{"first":true}\n');

    await atomicWriteTextFile(target, '{"second":true}\n');
    expect(await readFile(target, 'utf8')).toBe('{"second":true}\n');
  });

  it('preserves permissions when replacing an existing file', async () => {
    const target = path.join(cwd, 'source.html');
    await writeFile(target, '<body>old</body>');
    await chmod(target, 0o640);

    await atomicWriteTextFile(target, '<body>new</body>');

    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });
});
