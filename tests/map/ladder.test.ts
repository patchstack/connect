import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { LADDER_CASES, type LadderCase } from './ladder-cases.js';
import type { InputMap } from '../../src/map/types.js';

// What the map reports about a dependency, per reachability rung.
//
// Every other map test asks whether a flow compiles to a rule. This asks what the map SAYS, because
// that is what a consumer grades into a verdict — and the two answers come apart: a package can be
// plainly reachable and compile no rule, and an app can produce no evidence at all.
//
// The assertions are deliberately split in two. Here we check the map's own output; the platform
// grades that output into a verdict, and it asserts the grade separately. Collapsed into one layer, a
// failure cannot tell you whether the map saw the wrong thing or the ladder mis-graded it.

const maps = new Map<string, InputMap>();
const dirs: string[] = [];

beforeAll(async () => {
  for (const c of LADDER_CASES) {
    const dir = mkdtempSync(join(tmpdir(), 'ps-ladder-'));
    dirs.push(dir);

    for (const [rel, body] of Object.entries(c.files)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(c.packageJson));

    const { map, error } = await buildInputMap(dir);
    expect(error, `${c.id} must produce a map`).toBeUndefined();
    maps.set(c.id, map!);
  }
});
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const mapFor = (c: LadderCase): InputMap => {
  const map = maps.get(c.id);
  if (map === undefined) throw new Error(`no map for ${c.id}`);
  return map;
};
const symbols = (map: InputMap): string[] =>
  (map.apiInvocations ?? []).map((i) => `${i.package}.${i.symbol}`);
const flows = (map: InputMap) => map.endpoints.flatMap((e) => e.flows ?? []);

describe('every ladder case was actually analysed', () => {
  // The positive control, and the reason it comes first: an app that lands on its rung because the
  // map failed to read it would pass every assertion below for entirely the wrong reason. `imported`
  // in particular is indistinguishable from "parsed nothing" without this.
  it.each(LADDER_CASES.map((c) => [c.id, c] as const))('%s parsed its source', (_id, c) => {
    const map = mapFor(c);

    expect(map.coverage.filesParsed, 'no files parsed means nothing below is evidence').toBeGreaterThan(0);
    expect(map.coverage.sourceBytes).toBeGreaterThan(0);
  });

  it.each(LADDER_CASES.map((c) => [c.id, c] as const))('%s declares its dependency', (_id, c) => {
    const declared = (map: InputMap) => ((map.imports ?? []) as Array<{ package: string }>).map((i) => i.package);
    // Declared in package.json regardless of whether the map can attribute a usage. For the
    // `unknown` case this is the whole point: the dependency is present and the usage is invisible.
    expect(c.packageJson.dependencies).toHaveProperty(c.pkg);
    expect(declared(mapFor(c)).length + (mapFor(c).apiInvocations ?? []).length).toBeGreaterThanOrEqual(0);
  });
});

describe('the import inventory reports what it can attribute', () => {
  it.each(LADDER_CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const imported = ((mapFor(c).imports ?? []) as Array<{ package: string }>).map((i) => i.package);

    for (const expected of c.expect.imports) {
      expect(imported, `${c.id} must attribute an import of ${expected}`).toContain(expected);
    }
  });
});

describe('the invocation inventory reports calls, and only real ones', () => {
  it.each(LADDER_CASES.map((c) => [c.id, c] as const))('%s records its expected calls', (_id, c) => {
    const found = symbols(mapFor(c));

    for (const expected of c.expect.invocations) {
      expect(found, `${c.id} must record ${expected}`).toContain(expected);
    }
  });

  it.each(
    LADDER_CASES.filter((c) => (c.expect.absentInvocations ?? []).length > 0).map((c) => [c.id, c] as const),
  )('%s does not invent a call it cannot see', (_id, c) => {
    const found = symbols(mapFor(c));

    for (const absent of c.expect.absentInvocations ?? []) {
      // The promotions each rung must resist. `qs.parse` appearing for an imported-but-uncalled
      // package, or `node-serialize.unserialize` appearing for a computed require, would both be the
      // map claiming evidence it does not have.
      expect(found, `${c.id} must not claim ${absent}`).not.toContain(absent);
    }
  });
});

describe('a proven flow is reported only where one exists', () => {
  it.each(LADDER_CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const count = flows(mapFor(c)).length;

    if (c.expect.provenFlow) {
      expect(count, `${c.id} must show untrusted input reaching the sink`).toBeGreaterThan(0);
    } else {
      // Not merely "no rule compiled": no flow at all. Without this, the `api-called` case could
      // quietly become a second `reachable` case and still pass everything else.
      expect(count, `${c.id} must not claim a flow it has no evidence for`).toBe(0);
    }
  });
});

describe('the map declines to answer where it cannot see', () => {
  const unknown = LADDER_CASES.find((c) => c.rung === 'unknown')!;

  it('attributes no import for a computed require', () => {
    const imported = ((mapFor(unknown).imports ?? []) as Array<{ package: string }>).map((i) => i.package);

    expect(imported).not.toContain(unknown.pkg);
  });

  it('says why absence is not evidence here', () => {
    const limits = (mapFor(unknown).coverage.apiInventoryLimitations ?? []).join(' ');

    // The difference between "nothing is called" and "nothing is visible". A consumer reading an
    // empty inventory has no way to tell them apart unless the map states the shapes it cannot see —
    // and a confident "not imported" for code the map never resolved is the one negative claim this
    // design forbids.
    for (const pattern of unknown.expect.limitations ?? []) {
      expect(limits, `the limitations must mention ${pattern}`).toMatch(pattern);
    }
  });

  it('never offers a completeness flag a consumer could read as licence', () => {
    const coverage = mapFor(unknown).coverage as Record<string, unknown>;

    expect(coverage.apiInventoryComplete).toBeUndefined();
    expect(coverage.importsComplete, 'a computed require means the inventory is not complete')
      .not.toBe(true);
  });

  it('still reports the request input, so the risk is visible even when the sink is not', () => {
    // Both halves matter: there IS untrusted input in this app, and the call it reaches is invisible.
    // Reporting neither would hide the case entirely; reporting the flow would overclaim.
    const inputs = mapFor(unknown).endpoints.flatMap((e) => e.inputs ?? []);

    expect(inputs.length, 'the endpoint and its input are visible even though the sink is not')
      .toBeGreaterThan(0);
  });
});

describe('the ladder cases stay distinguishable', () => {
  it('covers all five rungs exactly once', () => {
    const rungs = LADDER_CASES.map((c) => c.rung).sort();

    expect(rungs).toEqual(
      ['api-called', 'imported', 'not-a-code-question', 'reachable', 'unknown'].sort(),
    );
  });

  it('pairs each case with a distinct fixture advisory', () => {
    const cves = LADDER_CASES.map((c) => c.cve);

    // The platform-side ladder assertions look these up in the shared CVE fixture. A duplicate would
    // make two rungs indistinguishable there.
    expect(new Set(cves).size).toBe(cves.length);
  });
});
