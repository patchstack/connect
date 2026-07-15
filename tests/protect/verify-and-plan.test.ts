import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProtect, runVerify } from '../../src/protect/install/index.js';

// For a stack no adapter matches, `protect` scaffolds a generic guard + prints a wiring plan
// (never silently skips), and `protect --check` (runVerify) drives the wire-then-verify loop.

function genericApp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-generic-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { express: '^4.19.0' } }));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src/server.ts'), 'export const app = {};\n');
  return dir;
}

describe('generic scaffold + wiring plan (unmatched stack)', () => {
  let dir: string;
  beforeEach(() => {
    dir = genericApp();
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('scaffolds a generic guard + returns a plan instead of silently skipping', () => {
    const res: any = runProtect(dir);
    expect(res.status).toBe('scaffolded');
    expect(res.adapter).toBe('generic');
    expect(res.changed).toContain('src/patchstack/guard.ts');
    expect(existsSync(path.join(dir, 'src/patchstack/guard.ts'))).toBe(true);
    expect(res.plan).toContain('protectFetch'); // wiring instructions
    expect(res.plan).toContain('src/server.ts'); // detected entry
    expect(res.plan).toContain('Express detected');
    expect(res.plan).toContain('--check');
  });

  it('reports NOT wired until the guard is imported into a server entry, then wired', () => {
    runProtect(dir);
    let report: any = runVerify(dir);
    expect(report.stack).toBe('generic');
    expect(report.wired).toBe(false);
    expect(report.checks.find((c: any) => c.label.includes('scaffolded')).ok).toBe(true);
    expect(report.checks.find((c: any) => c.label.includes('imported')).ok).toBe(false);

    // Simulate the agent wiring it into the entry point.
    writeFileSync(
      path.join(dir, 'src/server.ts'),
      'import { protectFetch } from "./patchstack/guard";\nexport default { fetch: protectFetch(() => new Response("ok")) };\n',
    );
    report = runVerify(dir);
    expect(report.wired).toBe(true);
  });
});
