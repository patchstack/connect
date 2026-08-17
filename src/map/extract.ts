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
import { isProvenFlow } from './coordinates.js';
import { extractFromFile } from './entries.js';
import { collectFileImports, createImportInventory, readPathAliases, scanFileImports } from './imports.js';

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
  const imports = createImportInventory(readPathAliases(cwd));
  let parsed = 0;
  let preFiltered = 0;

  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8');
      const relFile = relative(cwd, file);
      // Imports are collected from EVERY file, entry point or not: the data layer of an AI-built app
      // usually lives in a file with no handler in it, so a pre-filtered file is exactly where the
      // interesting dependency is imported.
      if (!hasEntrySignal(text)) {
        preFiltered++;
        imports.add(relFile, scanFileImports(text, ts), false);
        continue;
      }
      parsed++;
      // Coordinates are only valid for the exact file content they were derived from.
      const fingerprint = createHash('sha256').update(text).digest('hex').slice(0, 16);
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, guessScriptKind(ts, file));
      const bindings = buildModuleBindings(sf, ts);
      imports.add(relFile, collectFileImports(sf, ts), true);
      const ctx = { file, owner: relFile, graph };
      // The ctx reaches helper summaries too, so a same-file helper using an imported client resolves.
      const localSinks = collectLocalSinks(sf, ts, bindings, ctx);
      for (const ep of extractFromFile(sf, ts, localSinks, bindings, ctx)) {
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
  notes.push('`inputs` and `sinks` are INVENTORIES (both present in the handler). Only `flows` asserts that an input reaches a sink: require confidence "exact-local" or "transformed-local" before pinning a rule, and identify the input by `inputId` — a field NAME can occur in more than one request namespace.');
  notes.push('Sinks are followed into same-file helpers and ONE hop into an imported relative module (a dependency\u2019s internals are not followed); deeper or dynamic indirection is not traced. Sinks inside declared-but-uncalled local functions are excluded.');
  notes.push('A sink `package` is resolved from the file’s imports (`attribution: "import"`) or inferred from another import in the same file (`"inferred"`); an inferred package is a hint for a reviewer, not evidence about the receiver, and never licenses a rule.');
  if (!options.followSymlinks) notes.push('Symlinks leaving the project directory were not followed (use --follow-symlinks to include them).');
  if (failed.length > 0) {
    const sample = failed.slice(0, 5).join(', ');
    notes.push(`${failed.length} file(s) could not be analyzed and were skipped (fail-open): ${sample}${failed.length > 5 ? ', …' : ''}.`);
  }
  const unresolved = endpoints.filter((e) => e.inputsResolved === false).length;
  if (unresolved > 0) {
    notes.push(`${unresolved} endpoint(s) declare an input validator that could not be statically parsed — their inputs are UNKNOWN, not empty (marked inputsResolved: false).`);
  }
  const heuristicOnly = endpoints.filter((e) => e.sinks.length > 0 && e.inputs.length > 0 && !e.flows.some((f) => isProvenFlow(f.confidence))).length;
  if (heuristicOnly > 0) {
    notes.push(`${heuristicOnly} endpoint(s) have inputs and sinks but no proven data link — their flows say "may reach", not "does reach" (see each flow's confidence).`);
  }
  if (endpoints.length === 0) notes.push('No recognized server-side entry points found under the analyzed roots.');

  const importList = imports.list();
  const unmodelled = importList.filter((d) => d.recognizedSinkKinds.length === 0).length;
  notes.push('`imports` lists every package the app imports, from ALL source files — not only files holding an entry point. Absence of a package there is meaningful; absence of a SINK for a package is not.');
  notes.push(`${unmodelled} of ${importList.length} imported package(s) have no recognized sink family (recognizedSinkKinds: []). The extractor models a small set of API families, so for those packages it cannot tell whether input reaches them: a vulnerability in one must stay "needs review" and can never be closed as unreachable using this map.`);

  return {
    version: 3,
    framework: detectFramework(cwd),
    endpoints,
    imports: importList,
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
