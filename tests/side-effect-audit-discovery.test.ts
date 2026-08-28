import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the side-effect audit looks at, and what it does when there is nothing to look at.
 *
 * Both matter more than they appear to. The audit's output is a list of files followed by a summary, and
 * an artifact absent from that list is indistinguishable from one that reported clean — so a discovery
 * step which quietly finds a subset produces a report that looks complete and is not. That is the same
 * defect the audit itself exists to find, one level up.
 *
 * Driven against temporary directories rather than the real build, so the cases can be constructed rather
 * than waited for: a nested artifact, and no artifacts at all.
 */
const script = fileURLToPath(new URL('../scripts/side-effect-audit.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));

const run = (args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root });

/** The `dist/…` paths the report listed, which is exactly the set it spoke for. */
const audited = (stdout: string): string[] =>
  stdout
    .split('\n')
    .map((line) => /^\s{2}(\S+)\s+\(\d+ kB/.exec(line)?.[1])
    .filter((v): v is string => v !== undefined);

describe('what the audit discovers', () => {
  it('finds artifacts in subdirectories, not just the top level', () => {
    // The scaffolder's guard templates are emitted into `dist/protect/templates/` and are the files copied
    // into a consumer's application. A non-recursive listing left every one of them out.
    const dir = mkdtempSync(join(tmpdir(), 'ps-audit-'));
    mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(dir, 'top.js'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'nested', 'middle.cjs'), 'module.exports = 1;\n');
    writeFileSync(join(dir, 'nested', 'deeper', 'bottom.js'), 'export const b = 2;\n');
    // Not JavaScript, and not to be reported as if it were.
    writeFileSync(join(dir, 'nested', 'notes.md'), '# not code\n');
    writeFileSync(join(dir, 'nested', 'types.d.ts'), 'export declare const c: number;\n');

    const result = run([`--dir=${dir}`]);
    const found = audited(result.stdout).map((p) => p.slice(dir.length + 1));
    rmSync(dir, { recursive: true, force: true });

    expect(found.sort()).toEqual(['nested/deeper/bottom.js', 'nested/middle.cjs', 'top.js']);
    expect(result.status).toBe(0);
  });

  it('refuses to report on an empty directory instead of reporting nothing', () => {
    // A summary saying nothing executes anywhere reads exactly like a pass. An empty or half-written build
    // directory has to be an error, because the honest answer is that no artifact was examined.
    const dir = mkdtempSync(join(tmpdir(), 'ps-audit-'));

    const result = run([`--dir=${dir}`]);
    rmSync(dir, { recursive: true, force: true });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('no .js or .cjs');
  });

  it('refuses a directory that does not exist', () => {
    const result = run(['--dir=/definitely/not/here']);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('does not exist');
  });

  it('speaks for every emitted artifact of the real build', () => {
    // The claim the report makes about this repository. Compared against an independent walk of `dist/`
    // rather than against a remembered number, so adding an entry point cannot leave the audit behind.
    const dist = join(root, 'dist');
    if (!existsSync(dist)) return;

    const expected: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|cjs)$/.test(entry.name)) expected.push(full);
      }
    };
    walk(dist);

    const result = run([]);
    const found = audited(result.stdout).map((p) => join(root, p));

    expect(found.sort()).toEqual(expected.sort());
  });
});
