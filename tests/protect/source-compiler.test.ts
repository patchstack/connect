import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsedSource, sourceCompiler } from '../../src/protect/install/syntax.js';
import { nextCompiler } from '../../src/protect/install/adapters/next-source.js';
import { loadTypeScript } from '../../src/map/ts-loader.js';

describe('TypeScript resolution', () => {
  let cwd: string;
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("passes over a project TypeScript without the compiler API and parses with Connect's own", async () => {
    cwd = mkdtempSync(join(tmpdir(), 'ps-ts-'));
    writeFileSync(join(cwd, 'package.json'), '{"name":"app"}');
    mkdirSync(join(cwd, 'node_modules', 'typescript'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"7.0.0","main":"index.js"}');
    writeFileSync(join(cwd, 'node_modules', 'typescript', 'index.js'), 'module.exports = { version: "7.0.0" };');

    const ts = sourceCompiler(cwd);
    expect(ts).not.toBeNull();
    expect(parsedSource(ts!, 'a.ts', 'export const a: number = 1;')).not.toBeNull();
    expect(nextCompiler(cwd)?.ScriptTarget).toBeDefined();
    expect((await loadTypeScript(cwd))?.ScriptTarget).toBeDefined();
  });
});
