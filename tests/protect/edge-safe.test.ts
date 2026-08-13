import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The protect runtime is the module an EDGE guard imports (Next edge middleware, Cloudflare Workers,
// Deno, Bun, Supabase Functions). A STATIC top-level import of a Node builtin breaks those runtimes at
// build/load time — a bare `fs` specifier (what the bundler emits from `node:fs`) doesn't resolve at
// all — taking the whole guard down. Node-only capabilities (disk rule cache, .patchstackrc.json,
// node:http egress patching, DNS screening) must therefore be loaded with a DYNAMIC `await import(…)`
// so they're absent-but-harmless off Node. This test pins that invariant.

const PROTECT_DIR = fileURLToPath(new URL('../../src/protect/', import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'templates' || e.name === 'install') continue; // scaffolded/CLI-side, not the runtime graph
    const full = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.(js|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// `import … from 'node:x'` / `'fs'` / `require('node:x')` at module scope. Dynamic `await import(…)` is fine.
const STATIC_NODE_IMPORT =
  /^\s*(?:import\s[^;]*?\sfrom\s*|import\s*)['"](?:node:[a-z_/]+|fs|path|os|crypto|dns|net|http|https|child_process|worker_threads)['"]/m;

describe('protect runtime stays edge-safe', () => {
  const files = sourceFiles(PROTECT_DIR);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('never statically imports a Node builtin in the runtime graph', () => {
    const offenders = files.filter((f) => STATIC_NODE_IMPORT.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.replace(PROTECT_DIR, ''))).toEqual([]);
  });

  it('the built protect bundle has no static Node-builtin import (when dist is fresh)', () => {
    const dist = fileURLToPath(new URL('../../dist/protect.js', import.meta.url));
    if (!existsSync(dist)) return; // dist is gitignored and CI tests before building
    // Only assert against a build that reflects the current sources: a STALE dist (left by a build on
    // another branch) would otherwise fail this spuriously. The source-graph assertion above is the
    // real invariant and always runs.
    const distMtime = statSync(dist).mtimeMs;
    const newestSrc = Math.max(...files.map((f) => statSync(f).mtimeMs));
    if (distMtime < newestSrc) return;
    const built = readFileSync(dist, 'utf8');
    // The bundler rewrites `node:fs` → `fs`; either form at top level would break an edge build.
    const bad = built.match(/^import\s[^;]*?\sfrom\s*["'](?:node:)?(?:fs|path|child_process|dns|net|os)["']/gm);
    expect(bad ?? []).toEqual([]);
  });
});
