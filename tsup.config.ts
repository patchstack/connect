import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node18',
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    clean: false,
    sourcemap: true,
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
    target: 'node18',
  },
]);
