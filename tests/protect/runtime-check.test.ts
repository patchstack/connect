// The three answers the runtime check gives, the codes they exit with, and the lines they print.
//
// The middle answer is the one under test everywhere here: `unavailable` is neither a pass nor a
// failure, and the whole check is worth nothing if a caller can read it as either. So the exit code is
// its own, the printed lines say so in words, and the reason is never omitted.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Every case here starts a real process, so every case declares a timeout that fits the run it performs.
// The default five seconds is shorter than the runs below allow, and a test vitest abandons mid-run is
// not just a failure: the awaited promise is dropped, its cleanup never happens, and the app it started
// is left on the machine. Long enough for a loaded CI runner, and each run bounds itself anyway.
const SLOW = { timeout: 60_000 };


import {
  formatRuntimeCheck,
  runRuntimeCheck,
  runtimeExitCode,
  type RuntimeCheckReport,
} from '../../src/protect/install/runtime/check.js';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-runtime-check-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }

  return dir;
}

const report = (over: Partial<RuntimeCheckReport>): RuntimeCheckReport => ({ outcome: 'proven', listeners: [], output: '', ...over });

describe('an entry the check must not start', SLOW, () => {
  it('is unavailable, with the resolver’s reason and nothing launched', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'app', scripts: { start: 'tsx server.ts' } }),
      'server.ts': 'throw new Error("this must never run");',
    });
    const result = await runRuntimeCheck(dir);
    expect(result).toEqual({ outcome: 'unavailable', reason: expect.stringContaining('outside the bounded'), listeners: [], output: '' });
    expect(result.reason).not.toContain('tsx server.ts');
    expect(result.entry).toBeUndefined();
  });

  it('names the entry it did use, and where it came from', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'app', type: 'module', scripts: { start: 'node quiet.mjs' } }),
      'quiet.mjs': 'console.log("no listener here");',
    });
    const result = await runRuntimeCheck(dir, { timeoutMs: 4_000, settleMs: 300 });
    expect(result.entry).toEqual({ file: 'quiet.mjs', from: 'the "start" script' });
    expect(result.outcome).toBe('unavailable');
  });
});

describe('the exit code', SLOW, () => {
  it('is 0 only for a proven traversal', () => {
    expect(runtimeExitCode(report({ outcome: 'proven' }))).toBe(0);
  });

  it('is 1 when a listener answered and the seam did not', () => {
    expect(runtimeExitCode(report({ outcome: 'not-traversed' }))).toBe(1);
  });

  it('is 2 when nothing could be established — its own code, not either neighbour', () => {
    expect(runtimeExitCode(report({ outcome: 'unavailable' }))).toBe(2);
  });
});

describe('what the command prints', SLOW, () => {
  const printed = (over: Partial<RuntimeCheckReport>) => formatRuntimeCheck(report(over)).join('\n');

  it('states the claim in the one form it is allowed to take', () => {
    const out = printed({
      entry: { file: 'dist/server.js', from: 'the "start" script' },
      listeners: [{ scheme: 'http', host: '127.0.0.1', port: 5000, outcome: 'traversed' }],
    });
    expect(out).toContain('entry: dist/server.js (from the "start" script)');
    expect(out).toContain('✓ http://127.0.0.1:5000 — runtime traversal reached the scaffolded guard seam');
    expect(out).toContain('runtime traversal reached the scaffolded guard seam ✓');
    // Not a claim this check can make.
    expect(out).not.toMatch(/protected|blocked|rules/i);
  });

  it('prints the address that was actually bound', () => {
    const out = printed({ listeners: [{ scheme: 'http', host: '::1', port: 7000, outcome: 'traversed' }] });
    expect(out).toContain('http://[::1]:7000');
  });

  it('says which listener answered instead of the guard', () => {
    const out = printed({
      outcome: 'not-traversed',
      listeners: [
        { scheme: 'http', host: '127.0.0.1', port: 5000, outcome: 'traversed' },
        { scheme: 'https', host: '127.0.0.1', port: 5001, outcome: 'answered-without-sentinel' },
      ],
    });
    expect(out).toContain('✓ http://127.0.0.1:5000');
    expect(out).toContain('✗ https://127.0.0.1:5001 — the listener answered and the guard seam did not');
    expect(out).toContain('did NOT reach the scaffolded guard seam ✗');
  });

  it('marks an unreachable listener with its detail, not as a failure to traverse', () => {
    const out = printed({
      outcome: 'unavailable',
      reason: 'a listener could not be reached',
      listeners: [{ scheme: 'https', host: '127.0.0.1', port: 5001, outcome: 'unreachable', detail: 'socket hang up' }],
    });
    expect(out).toContain('? https://127.0.0.1:5001 — socket hang up');
  });

  it('always gives a reason for an answer it could not establish, and says it is not a failure', () => {
    const out = printed({ outcome: 'unavailable', reason: 'the "start" script runs `next start`' });
    expect(out).toContain('? runtime traversal could not be established — the "start" script runs `next start`');
    expect(out).toContain('This is not a failure.');
  });

  it('shows what the app printed when the answer was not a pass', () => {
    expect(printed({ outcome: 'unavailable', reason: 'x', output: 'Error: EADDRINUSE' })).toContain('    Error: EADDRINUSE');
  });

  it('does not pad a pass with the app’s own log output', () => {
    const out = printed({ listeners: [{ scheme: 'http', host: '127.0.0.1', port: 1, outcome: 'traversed' }], output: 'listening on 3000' });
    expect(out).not.toContain('listening on 3000');
  });

  it('caps how much of the app’s output it repeats', () => {
    const out = printed({ outcome: 'unavailable', reason: 'x', output: Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') });
    expect(out).toContain('    line 19');
    expect(out).not.toContain('    line 20');
  });
});
