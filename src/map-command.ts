import { writeFileSync } from 'node:fs';
import { buildInputMap } from './map/index.js';
import { resolveConfig } from './config.js';
import { postInputMap } from './client.js';
import { isProvenFlow } from './map/coordinates.js';
import { type Flags, getStringFlag } from './flags.js';

/**
 * `patchstack-connect map` — build the attack-surface map and, with `--upload`, send it.
 *
 * Its own module because whether a map travels is decided here, and a test of that decision must be able
 * to call this without importing the entry point, which runs the CLI on import.
 */
export async function runMap(flags: Flags): Promise<number> {
  const cwd = getStringFlag(flags, 'dir') ?? process.cwd();
  const { map, error } = await buildInputMap(cwd, {
    followSymlinks: flags.get('follow-symlinks') === true,
  });
  if (!map) {
    console.error(`patchstack: ${error}`);
    return 1;
  }
  // Human summary → stderr; the JSON → stdout (so it can be piped / written). Report PROVEN flows
  // separately from the inventories: only a proven tier is evidence that an input reaches a sink.
  const inputs = map.endpoints.reduce((n, e) => n + e.inputs.length, 0);
  const sinks = map.endpoints.reduce((n, e) => n + e.sinks.length, 0);
  const proven = map.endpoints.reduce((n, e) => n + e.flows.filter((f) => isProvenFlow(f.confidence)).length, 0);
  const c = map.coverage;
  console.error(
    `patchstack: ${map.endpoints.length} entry point(s), ${inputs} input(s), ${sinks} sink(s), ` +
      `${proven} proven input→sink flow(s) [${map.framework}].`,
  );
  console.error(
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
    console.error(
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
    console.error(
      `patchstack: ${imported.length} package(s) imported — ${unmodelled} with no recognized sink family, ` +
        `so a vulnerability in those cannot be judged reachable or unreachable from this map.`,
    );
  }
  const json = JSON.stringify(map, null, 2);
  const out = getStringFlag(flags, 'out');
  if (out) {
    writeFileSync(out, json);
    console.error(`patchstack: wrote ${out}`);
  } else if (flags.get('upload') !== true) {
    // With --upload the map goes to Patchstack instead of stdout: printing a full structural document
    // AND sending it is noise, and the interesting output becomes what the server did with it.
    console.log(json);
  }

  // Opt-in, never implied. This is the only path that sends anything derived from source code, so it
  // takes an explicit flag rather than happening because a site UUID exists.
  if (flags.get('upload') === true) {
    // A map with no recognized entry points is still evidence, and withholding it was the difference
    // between "we could not judge this" and "we never looked". It carries the import inventory, the
    // recorded API invocations, the deployment shapes and the coverage limitations — which is what the
    // `imported`, `not-imported` and `api-called` tiers are decided from, none of which needs an
    // endpoint. The receiving end has always accepted it: `endpoints` is validated as `present`, with a
    // note that a project with no server entry points is legitimate.
    if (map.endpoints.length === 0) {
      console.error(
        'patchstack: no server entry points were recognized — uploading the import inventory and ' +
          'coverage notes anyway, so a vulnerability can still be judged imported or not. Nothing here ' +
          'can decide whether a request reaches it.',
      );
    }
    // Same resolution order as every other network path: CLI flags, then env, then `.patchstackrc.json`.
    const config = await resolveConfig({
      cwd,
      cliSiteUuid: getStringFlag(flags, 'site-uuid'),
      cliEndpoint: getStringFlag(flags, 'endpoint'),
    });
    const outcome = await postInputMap(config, map);
    if (outcome.result === 'stored') {
      console.error(`patchstack: uploaded the attack surface (revision ${outcome.revision}).`);
    } else if (outcome.result === 'unchanged') {
      console.error(`patchstack: attack surface unchanged since revision ${outcome.revision} — nothing to store.`);
    } else if (outcome.result === 'skipped') {
      console.error(`patchstack: did not upload the attack surface — ${outcome.message}`);
    } else {
      // Fail-open: this runs inside someone's build, so a Patchstack problem must not fail it.
      console.error(`patchstack: could not upload the attack surface — ${outcome.message}`);
    }
  }
  return 0;
}
