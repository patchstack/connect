import { loadTypeScript } from './ts-loader.js';
import { extractInputMap, type ExtractOptions } from './extract.js';
import type { SiteInputMap } from './types.js';

export type { SiteInputMap, Endpoint, InputField, Sink, Flow, Coverage } from './types.js';
export type { ExtractOptions } from './extract.js';

/**
 * Build the app's input-flow ("attack surface") map at build time. Resolves the target app's own
 * TypeScript to parse the source; returns { map: null, error } (never throws) when TS can't be
 * resolved, so the CLI can degrade with a clear message.
 */
export async function buildInputMap(
  cwd: string,
  options: ExtractOptions = {},
): Promise<{ map: SiteInputMap | null; error?: string }> {
  const ts = await loadTypeScript(cwd);
  if (!ts) {
    return {
      map: null,
      error:
        'Could not resolve a TypeScript compiler to parse the app. `map` uses your project’s own ' +
        '`typescript` (already a devDependency of a TypeScript app) — install it and retry.',
    };
  }
  const map = await extractInputMap(cwd, ts, options);
  return { map };
}
