import { defineConfig } from 'tsup';

/**
 * Maps are published; the source text inside them is not.
 *
 * A `.map` without `sourcesContent` still resolves a stack frame to the original file and line, which is
 * what a support conversation needs. Embedding the source text as well roughly doubles the published
 * package for something already public: this repository is open, and the version a consumer is running is
 * recorded accurately, so the file and line resolve against the matching tag.
 *
 * `scripts/build-edge.mjs` builds the edge bundle with its own esbuild call and has to set this too.
 * `tests/source-maps.test.ts` asserts it over every published artifact rather than trusting either.
 */
const noEmbeddedSources = (options: { sourcesContent?: boolean }): void => {
  options.sourcesContent = false;
};

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    esbuildOptions: noEmbeddedSources,
    target: 'node18',
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    clean: false,
    sourcemap: true,
    esbuildOptions: noEmbeddedSources,
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    // `map` parses the target app's source with a TypeScript compiler resolved at RUNTIME (the app's
    // own `typescript`, or the environment's). Never bundle the compiler into the CLI — it's a heavy
    // devDependency and the runtime guard never needs it.
    external: ['typescript'],
  },
  {
    // Vendored runtime protection engine (node-waf + createProtection + Supabase guard),
    // exported as @patchstack/connect/protect. The scaffolded app guard imports this.
    entry: { protect: 'src/protect/runtime.js' },
    format: ['esm', 'cjs'],
    clean: false,
    sourcemap: true,
    esbuildOptions: noEmbeddedSources,
    target: 'node18',
  },
]);
