// Build the EDGE variant of the protect runtime: dist/protect.edge.js
//
// Why a separate artifact rather than one universal bundle: making the Node imports dynamic
// (`await import('node:fs')`) keeps the module *loadable* off Node, but bundlers FOLLOW dynamic
// imports, so an edge bundler (Next edge middleware, Cloudflare Workers, Deno, Supabase Functions)
// still tries to resolve `node:fs`/`node:path` and fails the build. The only way to be bundle-clean is
// for those modules to be absent from the graph entirely.
//
// So this build replaces every Node-only module with a stub that REJECTS on import. The runtime already
// treats a failed `await import('node:fs')` as "no filesystem on this runtime" and falls back to the
// memory / pluggable (`ruleCache`) tiers, so behaviour is preserved — the disk cache and the manifest
// re-post simply aren't available, which is correct on edge.
//
// We call esbuild directly instead of adding a tsup entry because tsup externalises Node builtins
// before a plugin can intercept them (and drops the `node:` prefix while doing so).
import * as esbuild from 'esbuild';

const NODE_ONLY = /^(node:)?(fs|fs\/promises|path|os|dns|net|crypto|http|https|child_process|worker_threads|module|url)$/;
// `refresh-manifest` pulls in the lockfile scanner (node:fs/promises) — Node-only by nature.
const NODE_ONLY_LOCAL = /refresh-manifest(\.js)?$/;

const stubNodeOnly = {
  name: 'ps-stub-node-only',
  setup(build) {
    const toStub = () => ({ path: 'ps-edge-stub', namespace: 'ps-edge' });
    build.onResolve({ filter: NODE_ONLY }, toStub);
    build.onResolve({ filter: NODE_ONLY_LOCAL }, toStub);
    build.onLoad({ filter: /.*/, namespace: 'ps-edge' }, () => ({
      // Throwing on import is exactly what the runtime's try/catch fallbacks expect.
      contents: 'throw new Error("[patchstack] this module is Node-only and unavailable on an edge runtime");',
      loader: 'js',
    }));
  },
};

const result = await esbuild.build({
  entryPoints: { 'protect.edge': 'src/protect/runtime.js' },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'browser', // WinterCG: no Node globals assumed
  target: 'es2022',
  sourcemap: true,
  // Keep the stub inline so the artifact is a single self-contained file (an edge bundler should not
  // have to chase a chunk that only ever throws).
  splitting: false,
  plugins: [stubNodeOnly],
  logLevel: 'warning',
});

if (result.errors.length) {
  console.error('[patchstack] edge build failed');
  process.exit(1);
}
console.log('built dist/protect.edge.js (edge-safe: no Node modules in the graph)');
