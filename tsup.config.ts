import { cpSync, mkdirSync } from 'node:fs';

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
    // Ship the guard templates next to the built CLI so `protect` can scaffold them.
    onSuccess: async () => {
      mkdirSync('dist/protect', { recursive: true });
      cpSync('src/protect/templates', 'dist/protect/templates', { recursive: true });
    },
  },
]);
