import { loadTypeScript } from './ts-loader.js';
import { extractInputMap } from './extract.js';
import type { SiteInputMap } from './types.js';

export type { SiteInputMap, Endpoint, InputField, Sink } from './types.js';

/**
 * Build the app's input-flow ("attack surface") map at build time. Resolves the target app's own
 * TypeScript to parse the source; returns { map: null, error } (never throws) when TS can't be
 * resolved, so the CLI can degrade with a clear message.
 */
export async function buildInputMap(cwd: string): Promise<{ map: SiteInputMap | null; error?: string }> {
  const ts = await loadTypeScript(cwd);
  if (!ts) {
    return {
      map: null,
      error:
        'Could not resolve a TypeScript compiler to parse the app. `map` uses your project’s own ' +
        '`typescript` (already a devDependency of a TypeScript app) — install it and retry.',
    };
  }
  const map = await extractInputMap(cwd, ts);
  return { map };
}
