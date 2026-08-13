import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { TsModule } from './types.js';

// Load a TypeScript compiler for parsing the target app's source. We do NOT bundle `typescript` into
// connect (it's a heavy dep and the runtime guard never needs it) — instead we resolve the TARGET
// app's own installed `typescript` (every TS app has it, at the exact version its code expects), then
// fall back to a `typescript` resolvable from connect's own context (dev/global). Returns null if
// neither is available, so the caller can degrade with a clear message rather than crash.
export async function loadTypeScript(cwd: string): Promise<TsModule | null> {
  // 1. The target app's node_modules (the normal case).
  try {
    const req = createRequire(pathToFileURL(join(cwd, 'package.json')));
    const resolved = req.resolve('typescript');
    const mod = await import(pathToFileURL(resolved).href);
    return (mod.default ?? mod) as TsModule;
  } catch {
    /* fall through */
  }
  // 2. A `typescript` resolvable from here (connect dev / a global install).
  try {
    const mod = await import('typescript');
    return (mod.default ?? mod) as TsModule;
  } catch {
    return null;
  }
}
