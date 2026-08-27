import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// A REAL edge build test. The source-level "no static node import" check (edge-safe.test.ts) is
// necessary but NOT sufficient: bundlers FOLLOW dynamic imports, so `await import('node:fs')` still
// fails to resolve in an edge build. Only bundling the shipped artifact the way Next edge middleware /
// Cloudflare Workers / Deno do proves it. This test does exactly that with esbuild
// (platform: 'browser', nothing external) and then RUNS the bundle to prove behaviour survives.

const root = fileURLToPath(new URL('../../', import.meta.url));
const EDGE = root + 'dist/protect.edge.js';

async function bundlesForEdge(entry: string): Promise<{ ok: boolean; errors: string[] }> {
  const esbuild = await import('esbuild');
  try {
    await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
    return { ok: true, errors: [] };
  } catch (e: any) {
    return { ok: false, errors: (e.errors ?? []).map((x: any) => x.text) };
  }
}

describe('edge bundle', () => {
  beforeAll(() => {
    if (!existsSync(EDGE)) {
      // CI runs tests before the build; build just this artifact so the assertions are real.
      execFileSync(process.execPath, ['scripts/build-edge.mjs'], { cwd: root, stdio: 'ignore' });
    }
  }, 120_000);

  it('bundles for an edge runtime with no Node builtins available', async () => {
    const { ok, errors } = await bundlesForEdge(EDGE);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  }, 60_000);

  it('contains no Node builtin import at all (static or dynamic)', () => {
    const src = readFileSync(EDGE, 'utf8');
    const refs = src.match(/(?:^|[\s(])(?:import|require)\s*\(?\s*["'](?:node:)?(?:fs|fs\/promises|path|os|dns|net|crypto|child_process|worker_threads|module)["']/gm);
    expect(refs ?? []).toEqual([]);
  });

  it('still enforces rules when imported (no filesystem, cacheDir ignored)', async () => {
    const { createProtection } = await import(EDGE);
    const rules = {
      firewall: [{ id: 'edge-1', rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '__proto__' } }] }],
      whitelists: [],
      whitelist_keys: {},
    };
    // cacheDir is deliberately set: the disk tier must fail open on a filesystem-less runtime.
    const p: any = await createProtection({ rules, mode: 'block', cacheDir: '/tmp/ignored-on-edge' });
    const post = (body: string) =>
      new Request('https://app.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect((await p.fetch(() => new Response('ok'))(post('{"__proto__":{"x":1}}'))).status).toBe(403);
    expect((await p.fetch(() => new Response('ok'))(post('{"a":1}'))).status).toBe(200);
  }, 60_000);

  it('is selected by edge conditions in package.json exports', () => {
    const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
    const protect = pkg.exports['./protect'];
    for (const cond of ['workerd', 'worker', 'edge-light', 'deno', 'browser']) {
      expect(protect[cond]).toBe('./dist/protect.edge.js');
    }
    // Node still gets the full build. Nested now, because the types differ per format: a CommonJS
    // consumer resolving `require` must be handed the `.d.cts` declarations, or TypeScript reads the ESM
    // ones, concludes the target is an ES module and refuses the `require` outright.
    expect(protect.import).toEqual({ types: './dist/protect.d.ts', default: './dist/protect.js' });
    expect(protect.require).toEqual({ types: './dist/protect.d.cts', default: './dist/protect.cjs' });

    // Condition order matters: an edge condition must be matched before the generic `import`.
    const keys = Object.keys(protect);
    expect(keys.indexOf('workerd')).toBeLessThan(keys.indexOf('import'));
    // And `default` must be last, or it shadows everything after it.
    expect(keys.indexOf('default')).toBe(keys.length - 1);
  });

  it('ships the declarations both format conditions point at', () => {
    // The map can name a file that the build never produces, and the failure surfaces three layers away as
    // "cannot find module" in a consumer's project. `protect.d.cts` did not exist at all while `require`
    // was already being advertised.
    const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
    const shipped = pkg.files as string[];

    for (const entry of [pkg.exports['.'], pkg.exports['./protect']]) {
      for (const condition of ['import', 'require'] as const) {
        const target = entry[condition] as { types: string; default: string };
        for (const file of [target.types, target.default]) {
          // `files` is the allowlist: a path outside it resolves locally and is absent from the tarball.
          expect(shipped.some((allowed) => file.startsWith(`./${allowed}`))).toBe(true);
          expect(existsSync(root + file.replace(/^\.\//, '')), `${file} is exported but not built`).toBe(true);
        }
      }
    }
  });
});
