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
// The same declarations under the CommonJS extension, because `exports` routes the `require` condition to
// them. TypeScript reads the declarations beside the condition it resolved, and an ESM `.d.ts` there tells
// it the target is an ES module — so it refuses the `require` (TS1479) even though the runtime works.
//
// A copy rather than a second generated file: tsup emits the root's `.d.ts` and `.d.cts` byte-identical,
// so there is nothing per-format to express.
copyFileSync('src/protect/protect.d.ts', 'dist/protect.d.cts');
console.log('copied protect types -> dist/protect.d.ts, dist/protect.d.cts');
