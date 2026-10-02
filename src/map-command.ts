import path from 'node:path';
import { buildInputMap } from './map/index.js';
import { resolveConfig } from './config.js';
import { postInputMap } from './client.js';
import { ingestProblems } from './map/budget.js';
import { isProvenFlow } from './map/coordinates.js';
import { type Flags, getStringFlag } from './flags.js';
import { applyBuildStamp } from './build-stamp.js';
import { isPreBundleBuildHook } from './build-hook.js';
import { inputMapBuildId } from './input-map-id.js';
import { atomicWriteFileSync } from './safe-file.js';
import type { Config } from './types.js';

export interface MapResult {
  code: number;
  endpoints?: number;
  buildId?: string | null;
  upload?: Awaited<ReturnType<typeof postInputMap>>;
  error?: string;
}

interface MapOptions {
  config?: Config;
  /** Setup edits source for the NEXT server start, never the already-running process. */
  setup?: boolean;
  log?: (line: string) => void;
}

/**
 * `patchstack-connect map` — build the attack-surface map and, with `--upload`, send it.
 *
 * Its own module because whether a map travels is decided here, and a test of that decision must be able
 * to call this without importing the entry point, which runs the CLI on import.
 */
export async function runMap(flags: Flags): Promise<number> {
  return (await runMapDetailed(flags)).code;
}

export async function runMapDetailed(flags: Flags, options: MapOptions = {}): Promise<MapResult> {
  const log = options.log ?? console.error;
  const cwd = getStringFlag(flags, 'dir') ?? process.cwd();
  // Setup may be rerun after a source change or an unsuccessful analysis. Never leave its old identity.
  if (options.setup) applyBuildStamp(cwd, null);
  const { map, error } = await buildInputMap(cwd, {
    followSymlinks: flags.get('follow-symlinks') === true,
  });
  if (!map) {
    log(`patchstack: ${error}`);
    return { code: isPreBundleBuildHook() ? 0 : 1, error: error ?? 'could not analyse the project' };
  }
  // Human summary → stderr; the JSON → stdout (so it can be piped / written). Report PROVEN flows
  // separately from the inventories: only a proven tier is evidence that an input reaches a sink.
  const inputs = map.endpoints.reduce((n, e) => n + e.inputs.length, 0);
  const sinks = map.endpoints.reduce((n, e) => n + e.sinks.length, 0);
  const proven = map.endpoints.reduce((n, e) => n + e.flows.filter((f) => isProvenFlow(f.confidence)).length, 0);
  const c = map.coverage;
  log(
    `patchstack: ${map.endpoints.length} entry point(s), ${inputs} input(s), ${sinks} sink(s), ` +
      `${proven} proven input→sink flow(s) [${map.framework}].`,
  );
  log(
    // All three buckets, explicitly: "6/66 parsed" reads as "91% unanalysed" when the other 60 files
    // simply contain no server entry point (most of a project is client code). Only `skipped` is a
    // failure to analyse.
    `patchstack: ${c.filesDiscovered} file(s) found — ${c.filesParsed} analysed, ` +
      `${c.filesPreFiltered} skipped (no server entry point)` +
      (c.filesSkipped ? `, ${c.filesSkipped} could not be analysed` : '') +
      `. DETECTED surface only — static analysis is best-effort; every flow carries the tier it was ` +
      `established at ("exact-local" and "transformed-local" are proven; "imported", "heuristic" and ` +
      `"unknown" are not).`,
  );
  const invoked = map.apiInvocations ?? [];
  if (invoked.length > 0) {
    const c = map.coverage as unknown as Record<string, number>;
    const dependency = c.callsDependency ?? 0;
    const ambiguous = c.callsAmbiguous ?? 0;
    // Resolver quality, NOT "share of all calls": local helpers are excluded from both terms, because
    // declining to attribute `res.json()` to a package is a correct answer rather than a miss.
    const denominator = dependency + ambiguous;
    const quality = denominator > 0 ? Math.round((100 * dependency) / denominator) : 100;
    log(
      `patchstack: ${invoked.length} dependency API call(s) resolved across ${new Set(invoked.map((i) => i.package)).size} package(s) ` +
        `from ${c.callsTotal ?? 0} call site(s) — ${quality}% of dependency-candidate receivers resolved ` +
        `(${c.callsLocal ?? 0} local, ${ambiguous} ambiguous). Positive evidence only: absence here never ` +
        `means an API is not called.`,
    );
  }
  const imported = map.imports ?? [];
  if (imported.length > 0) {
    // The unmodelled count is the honest headline: it is how much of the dependency surface this map
    // cannot speak to at all, and a reader who only sees flows would never learn it.
    const unmodelled = imported.filter((d) => d.recognizedSinkKinds.length === 0).length;
    log(
      `patchstack: ${imported.length} package(s) imported — ${unmodelled} with no recognized sink family, ` +
        `so a vulnerability in those cannot be judged reachable or unreachable from this map.`,
    );
  }
  const json = JSON.stringify(map, null, 2);
  const out = getStringFlag(flags, 'out');
  if (out) {
    atomicWriteFileSync(path.resolve(out), json, { encoding: 'utf8' });
    log(`patchstack: wrote ${out}`);
  } else if (flags.get('upload') !== true) {
    // With --upload the map goes to Patchstack instead of stdout: printing a full structural document
    // AND sending it is noise, and the interesting output becomes what the server did with it.
    console.log(json);
  }

  // Explicit standalone upload, or the documented upload within the setup workflow.
  if (flags.get('upload') === true) {
    // A map the API would refuse whole is not sent: the upload would fail anyway, after the work of sending it.
    const problems = ingestProblems(map);
    if (problems.length > 0) {
      log(`patchstack: did not upload the attack surface — it cannot be fitted to the size Patchstack accepts (${problems.join('; ')}).`);

      return { code: 0, endpoints: map.endpoints.length, error: problems.join('; ') };
    }
    // A map with no recognized entry points is still evidence, and withholding it was the difference
    // between "we could not judge this" and "we never looked". It carries the import inventory, the
    // recorded API invocations, the deployment shapes and the coverage limitations — which is what the
    // `imported`, `not-imported` and `api-called` tiers are decided from, none of which needs an
    // endpoint. The receiving end has always accepted it: `endpoints` is validated as `present`, with a
    // note that a project with no server entry points is legitimate.
    if (map.endpoints.length === 0) {
      log(
        'patchstack: no server entry points were recognized — uploading the import inventory and ' +
          'coverage notes anyway, so a vulnerability can still be judged imported or not. Nothing here ' +
          'can decide whether a request reaches it.',
      );
    }
    // Same resolution order as every other network path: CLI flags, then env, then `.patchstackrc.json`.
    const config = options.config ?? await resolveConfig({
      cwd,
      cliSiteUuid: getStringFlag(flags, 'site-uuid'),
      cliEndpoint: getStringFlag(flags, 'endpoint'),
    });
    // Setup prepares the next startup; a prebuild upload prepares the next bundle. Both write the
    // identity of THIS map into the imported rules file. A standalone manual map remains unbound.
    let buildId: string | null = null;
    if (options.setup || isPreBundleBuildHook()) {
      const candidate = inputMapBuildId(map);
      const stamp = applyBuildStamp(cwd, candidate);
      if (stamp.kind === 'stamped' || stamp.kind === 'unchanged') {
        buildId = candidate;
        log(`patchstack: bound this map to ${stamp.file} (${candidate.slice(0, 12)}).`);
      } else {
        const reason = stamp.kind === 'skipped' ? stamp.reason : 'the rules file did not retain the map identity';
        log(
          `patchstack: could not bind this map to the runtime guard — ${reason}. ` +
            'Rules generated from these coordinates will detect only, not block.',
        );
      }
    } else {
      log(
        'patchstack: no runtime binding recorded — run `map --upload` in a prebuild hook before the bundler, ' +
          'so rules generated from these coordinates can be tied to the runtime guard. Until then they detect only, not block.',
      );
    }
    const outcome = await postInputMap(config, map, buildId);
    if (outcome.result === 'stored') {
      log(`patchstack: uploaded the attack surface (revision ${outcome.revision}).`);
    } else if (outcome.result === 'unchanged') {
      log(`patchstack: attack surface unchanged since revision ${outcome.revision} — nothing to store.`);
    } else if (outcome.result === 'skipped') {
      log(`patchstack: did not upload the attack surface — ${outcome.message}`);
    } else {
      // Fail-open: this runs inside someone's build, so a Patchstack problem must not fail it.
      log(`patchstack: could not upload the attack surface — ${outcome.message}`);
    }
    return { code: 0, endpoints: map.endpoints.length, buildId, upload: outcome };
  }
  return { code: 0, endpoints: map.endpoints.length };
}
