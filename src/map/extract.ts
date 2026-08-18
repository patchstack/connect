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
import { collectFileImports, countUnresolvableImports, createImportInventory, readPathAliases, scanFileImports } from './imports.js';
import { collectInvocations, createInvocationInventory } from './invocations.js';

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
  const stats: WalkStats = { discovered: 0, unwalked: 0 };
  const files = collectSources(cwd, boundary, { followOutside: options.followSymlinks }, [], new Set(), stats);
  const imports = createImportInventory(readPathAliases(cwd));
  const invocations = createInvocationInventory();
  let parsed = 0;
  let preFiltered = 0;
  let importScanFailures = 0;
  let unresolvableImports = 0;
  let sourceBytes = 0;
  const calls = { total: 0, dependency: 0, local: 0, ambiguous: 0 };
  const startedAt = Date.now();
  // Local modules an entry file imports directly — parsed after the walk for their invocations (below).
  const entryFiles = new Set<string>();
  const hopTargets = new Set<string>();

  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8');
      const relFile = relative(cwd, file);
      sourceBytes += text.length;
      // Imports are collected from EVERY file, entry point or not: the data layer of an AI-built app
      // usually lives in a file with no handler in it, so a pre-filtered file is exactly where the
      // interesting dependency is imported.
      if (!hasEntrySignal(text)) {
        preFiltered++;
        const scanned = scanFileImports(text, ts);
        if (scanned === null) importScanFailures++; // this file's imports are unknown, not empty
        else imports.add(relFile, scanned, false);
        unresolvableImports += countUnresolvableImports(text, ts);
        continue;
      }
      parsed++;
      entryFiles.add(file);
      // Coordinates are only valid for the exact file content they were derived from.
      const fingerprint = createHash('sha256').update(text).digest('hex').slice(0, 16);
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, guessScriptKind(ts, file));
      const bindings = buildModuleBindings(sf, ts);
      for (const specifier of bindings.imports) {
        if (!specifier.startsWith('.')) continue; // node_modules is not this app's surface
        const target = graph.resolveLocal(file, specifier);
        if (target !== undefined) hopTargets.add(target);
      }
      imports.add(relFile, collectFileImports(sf, ts), true);
      // Counted on this path too. A parsed file is not a covered file: `collectFileImports` requires a
      // string-literal specifier, so a computed require in an entry file is just as unattributable as
      // one in a pre-filtered file — and this is the path where it is easiest to assume otherwise.
      unresolvableImports += countUnresolvableImports(text, ts);
      const ctx = { file, owner: relFile, graph };
      // The ctx reaches helper summaries too, so a same-file helper using an imported client resolves.
      // The invocation inventory rides the parse we already did for sinks — no second pass, which is what
      // makes it cheap enough to ship before deciding whether to parse more files.
      const called = collectInvocations(sf, ts, bindings, ctx);
      invocations.add(called.invocations);
      calls.total += called.counts.total;
      calls.dependency += called.counts.dependency;
      calls.local += called.counts.local;
      calls.ambiguous += called.counts.ambiguous;
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

  // --- one hop: the local modules an entry file imports ----------------------
  // An entry file's dependency calls are usually not written IN the entry file. `src/server.js` imports
  // `loadConfig` from `./config`, and the `JSON5.parse(...)` call lives in config.js — a file with no entry
  // signal, so the walk above only scanned its imports. Reading the call from the file it is written in is
  // the difference between reporting the API an advisory names and reporting nothing about it.
  //
  // ONE hop, from entry files only, invocations only: no sinks, no endpoints, no recursion into what the
  // hop file itself imports. The bound is structural — reachable from an entry by a relative import —
  // rather than a file budget, so coverage is predictable from the app's shape instead of from its size.
  let hopParsed = 0;
  let hopFailures = 0;
  for (const target of hopTargets) {
    if (entryFiles.has(target)) continue; // already collected above, along with its endpoints
    try {
      const text = readFileSync(target, 'utf8');
      const sf = ts.createSourceFile(target, text, ts.ScriptTarget.Latest, true, guessScriptKind(ts, target));
      const bindings = buildModuleBindings(sf, ts);
      // `owner` is the hop file, so a site points at the line that makes the call rather than at the
      // entry file that reaches it. A coordinate naming the wrong file cannot be checked by hand.
      const called = collectInvocations(sf, ts, bindings, { file: target, owner: relative(cwd, target), graph });
      invocations.add(called.invocations);
      calls.total += called.counts.total;
      calls.dependency += called.counts.dependency;
      calls.local += called.counts.local;
      calls.ambiguous += called.counts.ambiguous;
      hopParsed++;
    } catch (e) {
      if (typeof process !== 'undefined' && process.env?.PS_MAP_DEBUG) console.error('[patchstack] map hop error', target, e);
      // Fail-open, and counted: these files were already read once for their imports, so they must NOT
      // join `failed` (that would double-count the skip and flip the import-completeness flag over a
      // gap that belongs to a different question).
      hopFailures++;
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
  // A file we could not read is a file whose imports we do not know — the same unknown as a failed scan.
  // An unwalked subtree is the quietest gap of the three: it produces no file, so no counter moves and
  // the tree just looks smaller. It has to be part of this or the flag certifies an inventory with a
  // hole in it.
  // Two kinds of gap, one flag. ENVIRONMENTAL gaps (unread, unscanned, unwalked) might close on a
  // re-run with different permissions; an INHERENT gap — a specifier computed at runtime — never will,
  // because no static pass can resolve it. Both make the inventory incomplete, so both clear the flag;
  // they are reported apart so a reviewer can tell "try again" from "this app cannot be answered
  // statically" instead of re-running against a permanent property of the source.
  const importCoverageGaps = {
    unreadableFiles: failed.length,
    unscannableFiles: importScanFailures,
    unwalkedPaths: stats.unwalked,
    unresolvableImports,
  };
  const environmentalGaps = failed.length + importScanFailures + stats.unwalked;
  const importsComplete = environmentalGaps === 0 && unresolvableImports === 0;
  notes.push('`imports` lists every package the app imports, from ALL source files — not only files holding an entry point. Absence of a SINK for a package is never evidence; absence of the PACKAGE is evidence only when coverage.importsComplete is true.');
  notes.push(`${unmodelled} of ${importList.length} imported package(s) have no recognized sink family (recognizedSinkKinds: []). The extractor models a small set of API families, so for those packages it cannot tell whether input reaches them: a vulnerability in one must stay "needs review" and can never be closed as unreachable using this map.`);
  if (environmentalGaps > 0) {
    notes.push(`The import inventory is INCOMPLETE: ${failed.length} file(s) could not be read, ${importScanFailures} could not be scanned, and ${stats.unwalked} path(s) could not be walked at all (unreadable directory, broken link, or a symlink leaving the project). A package may therefore be imported without appearing in \`imports\`. Do not read a package's absence as "not imported" while coverage.importsComplete is false.`);
  }
  if (unresolvableImports > 0) {
    notes.push(`The import inventory is INCOMPLETE for a reason no re-run can fix: ${unresolvableImports} import(s) do not name a resolvable module — either the specifier is computed at runtime (\`require(REGISTRY[kind])\`) or the loader itself was aliased (\`const r = require\`), so which package is loaded is not knowable from the source. Those imports appear NOWHERE in \`imports\` — not as an unresolved entry, simply absent — so a package's absence is not evidence of it being unused. This is a property of the application's code, not a scan failure. Reported conservatively: an aliased loader counts even if every call through it uses a literal.`);
  }

  const invocationList = invocations.list();
  if (invocationList.length > 0 || parsed > 0) {
    notes.push(`\`apiInvocations\` records ${invocationList.length} dependency API call(s) resolved from ${parsed} entry file(s) plus ${hopParsed} local module(s) they import directly. POSITIVE EVIDENCE ONLY: a package missing from it may still have its API called — see coverage.apiInventoryLimitations.`);
  }
  if (hopFailures > 0) {
    notes.push(`${hopFailures} local module(s) imported by an entry file could not be parsed, so any dependency call written in them is missing from \`apiInvocations\`.`);
  }

  // Node-only and best-effort: the map runs in a build, but the runtime this file belongs to must stay
  // edge-safe, so nothing here may assume `process`.
  //
  // Two numbers, because the obvious one is not the one a performance decision needs. `memoryUsage().rss`
  // is the resident size AT THIS MOMENT — after extraction, with the walk's garbage possibly already
  // collected — so calling it a peak would overstate what it measures. `resourceUsage().maxRSS` is a real
  // high-water mark, but for the whole process (it includes loading TypeScript), so it is an upper bound on
  // the cost of running `map` rather than extraction's own peak. Both are reported and both are labelled
  // for what they are.
  let rssBytes;
  let peakRssBytes;
  try {
    if (typeof process !== 'undefined') {
      if (typeof process.memoryUsage === 'function') rssBytes = process.memoryUsage().rss;
      if (typeof process.resourceUsage === 'function') {
        const maxRssKb = process.resourceUsage().maxRSS; // kilobytes, per Node's docs
        if (typeof maxRssKb === 'number' && maxRssKb > 0) peakRssBytes = maxRssKb * 1024;
      }
    }
  } catch { /* not available */ }

  return {
    version: 3,
    framework: detectFramework(cwd),
    endpoints,
    imports: importList,
    apiInvocations: invocationList,
    coverage: {
      adapter: 'agnostic-v1',
      filesDiscovered: stats.discovered,
      filesParsed: parsed,
      filesPreFiltered: preFiltered,
      filesHopParsed: hopParsed,
      filesSkipped: failed.length,
      pathsUnwalked: stats.unwalked,
      importsComplete,
      importCoverageGaps,
      apiInvocations: invocationList.length,
      callsTotal: calls.total,
      callsDependency: calls.dependency,
      callsLocal: calls.local,
      callsAmbiguous: calls.ambiguous,
      sourceBytes,
      analysisMs: Date.now() - startedAt,
      ...(rssBytes !== undefined ? { rssBytes } : {}),
      ...(peakRssBytes !== undefined ? { peakRssBytes } : {}),
      // The list IS the partiality statement. There is deliberately no `apiInventoryComplete`: parsing
      // every file would raise recall without removing any of these, so no parsing budget could make an
      // absent invocation mean "not called".
      apiInventoryLimitations: [
        'only files carrying an entry-point signal, and the local modules they import directly, are parsed — a call two hops away is unseen',
        'a computed callee or property (`client[name]()`) cannot be resolved to an API',
        'a dynamic import()/require() with a non-literal specifier is not traced',
        'reflection, generated code, and syntax that fails to parse are invisible',
        'a receiver reached through more than one local hop, or through dependency injection, is not followed',
      ],
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
