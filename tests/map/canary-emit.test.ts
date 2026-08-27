import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildInputMap } from '../../src/map/index.js';
import { CANARY_CASE } from './canary-case.js';

/**
 * Regeneration entry point for the canary map, plus the assertions that make it trustworthy to vendor.
 *
 * The platform commits this document and evaluates it into a verdict and a generated rule. That makes it
 * an artifact of THIS package, and the ladder maps established both the pattern and its one weakness:
 * nothing downstream can detect a fixture going stale, because no job over there runs this extractor. So
 * the emitter's job is to make regeneration one command and the diff reviewable, and the provenance stamp
 * says which commit produced it.
 *
 * Run:
 *   PS_CANARY_EMIT_DIR=/path/to/back/tests/Fixtures/Canary npx vitest run tests/map/canary-emit
 *
 * Skipped otherwise, so a normal suite run neither writes files nor needs a directory. The assertions
 * below are NOT skipped — they run on every suite run, so a change to the app or the extractor that would
 * invalidate the vendored copy fails here first, with a message about the map rather than about a verdict.
 */
const OUT = process.env.PS_CANARY_EMIT_DIR;

/** Per-machine measurements: no contract, and they would make every regeneration a diff on noise. */
const VOLATILE = ['analysisMs', 'rssBytes', 'peakRssBytes'] as const;

/** The platform's on-disk form. Byte-identical or it diffs. */
const serialize = (document: unknown) => `${JSON.stringify(document, null, 2)}\n`;

async function canaryMap(): Promise<Record<string, any>> {
  const dir = mkdtempSync(join(tmpdir(), 'ps-canary-emit-'));
  try {
    for (const [rel, body] of Object.entries(CANARY_CASE.files)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(CANARY_CASE.packageJson));

    const { map, error } = await buildInputMap(dir);
    expect(error, 'the canary app must produce a map').toBeUndefined();
    const document = map as Record<string, any>;
    for (const field of VOLATILE) delete document.coverage[field];

    return document;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Which commit produced the artifact. The only record of how fresh a vendored copy is. */
function provenance(): Record<string, unknown> {
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { /* not a git checkout — 'unknown' is the honest answer, not a failure */ }

  return {
    note: 'Generated from the canary app in @patchstack/connect. Do not edit; regenerate.',
    case: CANARY_CASE.id,
    cve: CANARY_CASE.cve,
    package: CANARY_CASE.pkg,
    packageVersion: CANARY_CASE.pkgVersion,
    producedByCommit: commit,
  };
}

describe.skipIf(!OUT)('emitting the canary map for the platform', () => {
  it('writes the map and its provenance', async () => {
    writeFileSync(join(OUT!, 'cve-2017-5941.map.json'), serialize(await canaryMap()));
    writeFileSync(join(OUT!, 'cve-2017-5941.provenance.json'), serialize(provenance()));

    console.log(`[canary] wrote cve-2017-5941.map.json and .provenance.json to ${OUT}`);
  });
});

describe('the canary map says what the chain downstream depends on', () => {
  // Runs always, not only when emitting. The platform grades this document into a verdict and a rule; if
  // the extractor stops reporting any of these, the vendored copy silently answers for a different app and
  // the failure surfaces three repositories away as a rule that stopped being generated. Failing here
  // instead is the entire point of asserting both ends.
  it('reports the endpoint, the coordinate and the sink', async () => {
    const map = await canaryMap();
    const endpoint = map.endpoints[0];

    expect(map.version).toBe(3);
    expect(endpoint.route).toBe(CANARY_CASE.expect.route);
    expect(endpoint.method).toBe(CANARY_CASE.expect.method);
    expect(endpoint.inputs.find((i: any) => i.name === 'state')?.runtimeParameter)
      .toBe(CANARY_CASE.expect.runtimeParameter);
    expect(endpoint.sinks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: CANARY_CASE.expect.sinkKind,
        package: CANARY_CASE.pkg,
        op: CANARY_CASE.expect.sinkOp,
      }),
    ]));
  });

  it('reports a flow the platform may act on', async () => {
    const map = await canaryMap();
    const flow = map.endpoints[0].flows.find((f: any) => f.sink.package === CANARY_CASE.pkg);

    expect(flow).toBeDefined();
    expect(flow.inputId).toBe(CANARY_CASE.expect.inputId);
    expect(flow.argumentRole).toBe(CANARY_CASE.expect.argumentRole);
    expect(flow.candidateFamily).toBe(CANARY_CASE.expect.candidateFamily);
    expect(flow.confidence).toBe(CANARY_CASE.expect.confidence);
    expect(flow.ruleGeneratable).toBe(CANARY_CASE.expect.ruleGeneratable);
  });

  it('declares that a dataflow question about the package can be answered', async () => {
    // `recognizedSinkKinds: []` would mean "no model of this API", and the recipe's gate is `dataflow` —
    // so an empty list turns the whole canary into a case the platform must leave as needs-review.
    const map = await canaryMap();

    expect(map.imports.find((i: any) => i.package === CANARY_CASE.pkg)?.recognizedSinkKinds).toEqual(['eval']);
  });

  it('carries the evidence blocks and no per-machine fields', async () => {
    // A map missing a block grades LOWER rather than failing — an absent `apiInvocations` reads as "no
    // call was seen" — so an emitter that quietly dropped one would produce a fixture that passes as a
    // conservative verdict. And a machine-specific number makes every regeneration a diff on noise.
    const map = await canaryMap();

    for (const field of VOLATILE) expect(map.coverage).not.toHaveProperty(field);
    expect(Array.isArray(map.imports)).toBe(true);
    expect(Array.isArray(map.apiInvocations)).toBe(true);
    expect(map.coverage.importsComplete).toBe(true);
  });

  it('serializes exactly as the platform stores it', () => {
    expect(serialize({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it('stamps the commit that produced the artifact', () => {
    // Without it a vendored map has no age. The ladder fixtures carry this as a hand-maintained line in a
    // README, which is only as fresh as the last person who remembered.
    expect(provenance().producedByCommit).toMatch(/^[0-9a-f]{40}$/);
  });
});
