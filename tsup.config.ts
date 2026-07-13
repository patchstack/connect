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
]);
