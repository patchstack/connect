import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliLog, readCliLog } from '../field-test/cli-log.mjs';

let dir: string;
let originalPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'field-cli-log-'));
  // A stand-in for the real npx: echoes its arguments to both streams and exits with a chosen code.
  const fakeBin = path.join(dir, 'fake-bin');
  execFileSync('mkdir', ['-p', fakeBin]);
  writeFileSync(path.join(fakeBin, 'npx'), '#!/usr/bin/env bash\necho "out: $*"\necho "err: $*" >&2\nexit "${FAKE_EXIT:-0}"\n');
  chmodSync(path.join(fakeBin, 'npx'), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('field-test Connect command log', () => {
  it('records Connect commands in order and passes everything through unchanged', () => {
    const log = createCliLog(path.join(dir, 'log'));
    const npx = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(path.join(log.binDir, 'npx'), args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });

    const first = npx(['--no-install', 'patchstack-connect', 'setup']);
    const other = npx(['vite', 'build']);
    const failed = npx(['@patchstack/connect', 'doctor'], { FAKE_EXIT: '3' });

    expect(first).toMatchObject({ status: 0, stdout: 'out: --no-install patchstack-connect setup\n', stderr: 'err: --no-install patchstack-connect setup\n' });
    expect(other).toMatchObject({ status: 0, stdout: 'out: vite build\n' });
    expect(failed.status).toBe(3);

    // Two commands within one second must stay separate records, in the order they ran.
    expect(readCliLog(log.logDir)).toEqual([
      { args: ['--no-install', 'patchstack-connect', 'setup'], cwd: dir, status: 0, stdout: 'out: --no-install patchstack-connect setup\n', stderr: 'err: --no-install patchstack-connect setup\n' },
      { args: ['@patchstack/connect', 'doctor'], cwd: dir, status: 3, stdout: 'out: @patchstack/connect doctor\n', stderr: 'err: @patchstack/connect doctor\n' },
    ]);
    expect(readdirSync(log.logDir).filter((file) => file.endsWith('.args'))).toHaveLength(2);
  });
});
