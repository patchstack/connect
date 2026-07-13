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
