// Copy the runtime-guard templates next to the built CLI so `patchstack-connect protect`
// can scaffold them. Runs AFTER tsup (post-build), so tsup's async .d.ts pass can't clobber
// the .d.ts templates (which it does if we copy via tsup's onSuccess).
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/protect', { recursive: true });
cpSync('src/protect/templates', 'dist/protect/templates', { recursive: true });
console.log('copied protect templates -> dist/protect/templates');
