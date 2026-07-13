// Copy the runtime-guard templates next to the built CLI so `patchstack-connect protect`
// can scaffold them. Runs AFTER tsup (post-build), so tsup's async .d.ts pass can't clobber
// the .d.ts templates (which it does if we copy via tsup's onSuccess).
import { cpSync, mkdirSync, copyFileSync } from 'node:fs';

mkdirSync('dist/protect', { recursive: true });
cpSync('src/protect/templates', 'dist/protect/templates', { recursive: true });
console.log('copied protect templates -> dist/protect/templates');

// Ship the hand-authored declarations for the `@patchstack/connect/protect` subpath (the runtime
// is plain JS, so tsup doesn't emit these). Referenced by the "./protect" export's `types`.
copyFileSync('src/protect/protect.d.ts', 'dist/protect.d.ts');
console.log('copied protect types -> dist/protect.d.ts');
