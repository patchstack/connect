import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cellGreen, roundGreen, summarizeRounds } from '../field-test/outcomes.mjs';
import { loadAgents, parseArgs } from '../field-test/matrix.mjs';
import { runAgent } from '../field-test/agent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const green = { audited: true, passed: 12, total: 12, exitCode: 0, timedOut: false, confirmTurn: false };
const voidRound = { ...green, audited: false, passed: 2 };
const temporary: string[] = [];

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'field-outcomes-'));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('field-test outcomes', () => {
  it('requires every requested round, even if the completed rounds all passed', () => {
    expect(summarizeRounds([green, voidRound], 3)).toMatchObject({ exitCode: 2, fullPasses: 1, promptPassed: false });
    expect(cellGreen({ exitCode: 0, rounds: [green] }, 3)).toBe(false);
  });

  it('keeps prompt reliability separate from retries that establish a documentation result', () => {
    expect(summarizeRounds([voidRound, green], 1)).toMatchObject({ exitCode: 0, voided: 1, promptPassed: false });
    expect(cellGreen({ exitCode: 0, rounds: [voidRound, green] }, 1)).toBe(false);
    expect(cellGreen({ exitCode: 0, rounds: [green] }, 1)).toBe(true);
  });

  it.each([
    { ...green, timedOut: true },
    { ...green, exitCode: 7 },
    { ...green, exitCode: null },
    { ...green, total: 0, passed: 0 },
    { ...green, confirmTurn: true, confirmExitCode: 1, confirmTimedOut: false },
    { ...green, confirmTurn: true, confirmExitCode: 0, confirmTimedOut: true },
  ])('rejects unsuccessful processes even when their files look complete: %j', (round) => {
    expect(roundGreen(round)).toBe(false);
    expect(summarizeRounds([round], 1).exitCode).toBe(1);
  });

  it('never passes an empty, unavailable, or failed matrix cell', () => {
    expect(cellGreen({ exitCode: 0, rounds: [] }, 1)).toBe(false);
    expect(cellGreen({ exitCode: null, rounds: null }, 1)).toBe(false);
    expect(cellGreen({ exitCode: 1, rounds: [green] }, 1)).toBe(false);
    expect(summarizeRounds([voidRound], 1).exitCode).toBe(2);
  });

  it.each(['0', '-1', 'NaN', 'Infinity', '1.5'])('rejects invalid round counts (%s) before launching an agent', (value) => {
    expect(() => parseArgs(['node', 'matrix.mjs', '--rounds', value])).toThrow(/positive integer/);
    const result = spawnSync(process.execPath, ['field-test/run.mjs', '--rounds', value], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('building fixture');
  });

  it('accepts named model commands without changing the built-in defaults', () => {
    const config = path.join(tempDir(), 'agents.json');
    const agent = { executable: 'model-cli', command: 'model-cli --model model-a --headless' };
    writeFileSync(config, JSON.stringify({ model_a: agent }));
    expect(loadAgents(config)).toMatchObject({ model_a: agent, claude: { executable: 'claude' } });
    writeFileSync(config, JSON.stringify({ broken: { command: '' } }));
    expect(() => loadAgents(config)).toThrow(/non-empty command/);
  });

  it('retains an unavailable requested agent in the actual matrix report and exits nonzero', () => {
    const config = path.join(tempDir(), 'agents.json');
    writeFileSync(config, JSON.stringify({ absent: { executable: 'field-test-missing-cli-7f361', command: 'field-test-missing-cli-7f361' } }));
    const result = spawnSync(process.execPath, [
      'field-test/matrix.mjs', '--agents', 'absent', '--personas', 'standard', '--agent-config', config,
    ], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('UNAVAILABLE');
    const directory = result.stdout.match(/^aggregate: (.+)$/m)?.[1];
    expect(directory).toBeDefined();
    temporary.push(directory!);
    const report = JSON.parse(readFileSync(path.join(directory!, 'matrix.json'), 'utf8'));
    expect(report.opts.agents).toEqual(['absent']);
    expect(report.cells).toMatchObject([{ agent: 'absent', unavailable: true }]);
  });
});

describe('agent process outcomes', () => {
  it('records a CLI that exits before consuming its prompt', async () => {
    const result = await runAgent('exit 7', 'request\n'.repeat(100_000), tempDir(), 'http://127.0.0.1:1/mock', 5000);
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('kills a timed-out shell and its child', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'wait.cjs'), "require('node:fs').writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000);\n");
    const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const result = await runAgent(`${node} wait.cjs & wait`, 'request', dir, 'http://127.0.0.1:1/mock', 1500);
    expect(result.timedOut).toBe(true);
    const pid = Number(readFileSync(path.join(dir, 'child.pid'), 'utf8'));
    // An orphan may briefly be a zombie until reaped, but it must not keep executing.
    let state = '';
    try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { /* Already reaped. */ }
    expect(state === '' || state.startsWith('Z')).toBe(true);
  });
});
