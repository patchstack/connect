import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import type { SiteInputMap, Endpoint, TsModule } from './types.js';
import { guessScriptKind } from './ast.js';
import { buildModuleBindings } from './bindings.js';
import { collectSources, detectFramework, hasEntrySignal, type WalkStats } from './sources.js';
import { functionNameFromPath, routeFromFilePath } from './routes.js';
import { collectLocalSinks } from './sinks.js';
import { createModuleGraph } from './module-graph.js';
import { extractFromFile } from './entries.js';

// Framework-AGNOSTIC input-flow extractor. It doesn't gate on a specific stack — it walks any JS/TS
// source and applies recognizer tables for (1) entry points, (2) inputs, (3) sinks, so it generalizes
// across builders (TanStack Start, Next, SvelteKit, Express/Fastify/Hono, …) and providers, and
// degrades gracefully (recording what it couldn't see in `coverage.notes`). Add a stack by adding a
// recognizer, not a new adapter.
//
// False-positive control: sink and validator recognizers are gated on the file's module bindings —
// a call whose receiver is a plain local object/class/function is NOT a dependency sink, and
// `.object({…})` is only read as an input schema when its receiver traces to a known validator
// package. Receivers that can't be traced (handler params, cross-file imports) stay heuristic,
// favoring recall over precision.

export interface ExtractOptions {
  /** Follow symlinks that leave the project directory (off by default — keeps analysis in-project). */
  followSymlinks?: boolean;
}

export async function extractInputMap(cwd: string, ts: TsModule, options: ExtractOptions = {}): Promise<SiteInputMap> {
  const notes: string[] = [];
  const endpoints: Endpoint[] = [];
  const failed: string[] = [];
  let boundary = cwd;
  try { boundary = realpathSync(cwd); } catch { /* use cwd as-is */ }

  const graph = createModuleGraph(ts, { cwd, boundary, followOutside: options.followSymlinks }); // shared cache
  const stats: WalkStats = { discovered: 0 };
  const files = collectSources(cwd, boundary, { followOutside: options.followSymlinks }, [], new Set(), stats);
  let parsed = 0;
  let preFiltered = 0;

  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8');
      if (!hasEntrySignal(text)) { preFiltered++; continue; }
      parsed++;
      // Coordinates are only valid for the exact file content they were derived from.
      const fingerprint = createHash('sha256').update(text).digest('hex').slice(0, 16);
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, guessScriptKind(ts, file));
      const bindings = buildModuleBindings(sf, ts);
      const localSinks = collectLocalSinks(sf, ts, bindings);
      const relFile = relative(cwd, file);
      for (const ep of extractFromFile(sf, ts, localSinks, bindings, { file, owner: relFile, graph })) {
        // A FILE-BASED route handler carries its URL path in its location, not in the code, so derive
        // it here — without this a rule can only be param-pinned, never route-scoped (`when.path`).
        if (ep.route === undefined && ep.entryKind === 'edge-function') {
          const fn = functionNameFromPath(relFile);
          if (fn) ep.route = '/' + fn; // how the platform invokes it (…/functions/v1/<name>)
        }
        if (ep.route === undefined && (ep.entryKind === 'route-handler' || ep.entryKind === 'server-action')) {
          const derived = routeFromFilePath(relFile);
          if (derived.route) {
            ep.route = derived.route;
            if (derived.dynamic) ep.routeDynamic = true;
          }
        }
        endpoints.push({ ...ep, file: relFile, fingerprint });
      }
    } catch (e) {
      // The fail-open below is right for production but hides bugs during development: a crash in the
      // extractor looks identical to an unparseable file. PS_MAP_DEBUG surfaces it.
      if (typeof process !== 'undefined' && process.env?.PS_MAP_DEBUG) console.error('[patchstack] map error', file, e);
      // Fail-open: one unreadable/unparseable file must never kill the whole map.
      failed.push(relative(cwd, file));
    }
  }

  notes.push('Static analysis is best-effort — this is the DETECTED surface, not a proof of completeness.');
  notes.push('`inputs` and `sinks` are INVENTORIES (both present in the handler). Only `flows` asserts that an input reaches a sink — prefer flows with confidence "precise" when pinning a rule to a parameter.');
  notes.push('Sinks are followed into same-file helpers and ONE hop into an imported relative module (a dependency\u2019s internals are not followed); deeper or dynamic indirection is not traced. Sinks inside declared-but-uncalled local functions are excluded.');
  notes.push('A sink `package` is resolved from the file’s imports (precise) or inferred from a known provider import; an unresolved package means the backing dependency could not be traced.');
  if (!options.followSymlinks) notes.push('Symlinks leaving the project directory were not followed (use --follow-symlinks to include them).');
  if (failed.length > 0) {
    const sample = failed.slice(0, 5).join(', ');
    notes.push(`${failed.length} file(s) could not be analyzed and were skipped (fail-open): ${sample}${failed.length > 5 ? ', …' : ''}.`);
  }
  const unresolved = endpoints.filter((e) => e.inputsResolved === false).length;
  if (unresolved > 0) {
    notes.push(`${unresolved} endpoint(s) declare an input validator that could not be statically parsed — their inputs are UNKNOWN, not empty (marked inputsResolved: false).`);
  }
  const heuristicOnly = endpoints.filter((e) => e.sinks.length > 0 && e.inputs.length > 0 && !e.flows.some((f) => f.confidence === 'precise')).length;
  if (heuristicOnly > 0) {
    notes.push(`${heuristicOnly} endpoint(s) have inputs and sinks but no PRECISE data link — their flows are "heuristic" (may reach), not proven.`);
  }
  if (endpoints.length === 0) notes.push('No recognized server-side entry points found under the analyzed roots.');

  return {
    version: 2,
    framework: detectFramework(cwd),
    endpoints,
    coverage: {
      adapter: 'agnostic-v1',
      filesDiscovered: stats.discovered,
      filesParsed: parsed,
      filesPreFiltered: preFiltered,
      filesSkipped: failed.length,
      roots: ['.'],
      notes,
    },
  };
}


function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Re-exported so `./extract.js` stays the directory's entry point for consumers and tests.
export { runtimeCoordinate } from './coordinates.js';
export { functionNameFromPath, routeFromFilePath } from './routes.js';
export type { WalkStats } from './sources.js';
export type { ModuleGraph } from './sinks.js';
