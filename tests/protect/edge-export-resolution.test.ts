import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Resolution test, complementing edge-bundle.test.ts. That one bundles dist/protect.edge.js DIRECTLY,
// which proves the artifact is edge-clean but NOT that a consumer ever reaches it — a mis-ordered or
// mistyped `exports` condition would silently hand an edge bundler the Node build. This test imports
// the real package specifier (`@patchstack/connect/protect`) from a fixture with the package linked into
// node_modules, and resolves it under each edge condition.
//
// The CONTROL is what makes it meaningful: with no edge condition the same import resolves to the Node
// build and FAILS to bundle for a Node-free target. So a pass here is caused by the condition, not by
// the target being lenient.

const repo = fileURLToPath(new URL('../../', import.meta.url));
let dir: string;

async function bundleWith(conditions: string[]): Promise<{ ok: boolean; text: string; errors: string[] }> {
  const esbuild = await import('esbuild');
  try {
    const r = await esbuild.build({
      entryPoints: [join(dir, 'entry.js')],
      bundle: true,
      write: false,
      format: 'esm',
      // 'neutral' adds no implicit conditions — 'browser' would inject the `browser` condition and mask
      // whether the edge conditions themselves work.
      platform: 'neutral',
      conditions,
      absWorkingDir: dir,
      logLevel: 'silent',
    });
    return { ok: true, text: r.outputFiles[0]!.text, errors: [] };
  } catch (e: any) {
    return { ok: false, text: '', errors: (e.errors ?? []).map((x: any) => x.text) };
  }
}

describe('edge conditional-export resolution', () => {
  beforeAll(() => {
    // The exports map points at dist/, so the artifacts must exist. CI runs tests before the build.
    if (!existsSync(join(repo, 'dist', 'protect.edge.js')) || !existsSync(join(repo, 'dist', 'protect.js'))) {
      execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: 'ignore' });
    }
    dir = mkdtempSync(join(tmpdir(), 'ps-export-res-'));
    mkdirSync(join(dir, 'node_modules', '@patchstack'), { recursive: true });
    symlinkSync(repo, join(dir, 'node_modules', '@patchstack', 'connect'), 'dir');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module' }));
    writeFileSync(join(dir, 'entry.js'), 'import { createProtection } from "@patchstack/connect/protect";\nexport { createProtection };\n');
  }, 300_000);

  it.each(['workerd', 'worker', 'edge-light', 'deno', 'browser'])(
    'resolves @patchstack/connect/protect to the edge build under the %s condition',
    async (condition) => {
      const r = await bundleWith([condition, 'import']);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      // The edge artifact is the only one carrying the Node-only stub message.
      expect(r.text).toContain('Node-only');
    },
    60_000,
  );

  it('CONTROL: without an edge condition it resolves to the Node build, which is not edge-bundleable', async () => {
    const r = await bundleWith(['import']);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Could not resolve "(node:)?(fs|path)"/);
  }, 60_000);
});
