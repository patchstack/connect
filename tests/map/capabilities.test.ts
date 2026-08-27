import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ADDRESS_SPACES,
  CAPABILITY_CONTROLS,
  ARGUMENT_ROLES,
  CANDIDATE_FAMILIES,
  CAPABILITY_MANIFEST,
  CAPABILITY_VERSION,
  CONFIDENCE_TIERS,
  PROVEN_CONFIDENCE_TIERS,
  SINK_KINDS,
} from '../../src/map/capabilities.js';
import { buildInputMap } from '../../src/map/index.js';
import { ADVERSARIAL } from './corpus-cases.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// The capability vocabulary is consumed by three separately-shipped layers: this extractor, the
// reachability recipe schema + validator, and the server that binds a coordinate into a rule. Drift
// between them fails SILENTLY — a sink kind this side knows and the recipe schema does not makes the
// capability unauthorable; one the server does not know makes every flow of that kind unusable. Nothing
// throws; the capability just never matches, which reads exactly like "not reachable".
//
// So these tests defend the contract itself: one definition, a committed manifest that cannot drift from
// it, and a version that has to move when the vocabulary does.
const root = join(import.meta.dirname, '..', '..');
const manifestPath = join(root, 'capabilities.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

describe('the committed manifest matches the source of truth', () => {
  it('is byte-identical to what the emitter produces', () => {
    // Would catch a hand-edit of capabilities.json, or a member added to the TS without regenerating.
    const out = execFileSync('node', [join(root, 'scripts/emit-capabilities.mjs'), '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(out).toContain('up to date');
  });

  it('agrees with the TypeScript definition member for member', () => {
    expect(manifest.version).toBe(CAPABILITY_VERSION);
    expect(manifest.sinkKinds).toEqual([...SINK_KINDS]);
    expect(manifest.argumentRoles).toEqual([...ARGUMENT_ROLES]);
    expect(manifest.candidateFamilies).toEqual([...CANDIDATE_FAMILIES]);
    expect(manifest.confidenceTiers).toEqual([...CONFIDENCE_TIERS]);
    expect(manifest.provenConfidenceTiers).toEqual([...PROVEN_CONFIDENCE_TIERS]);
    expect(manifest.addressSpaces).toEqual([...ADDRESS_SPACES]);
  });

  it('carries a semver version, so a consumer can pin and detect a break', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the contract is internally consistent', () => {
  it('every proven tier is a real tier, in strongest-first order', () => {
    for (const tier of PROVEN_CONFIDENCE_TIERS) expect(CONFIDENCE_TIERS).toContain(tier);
    expect(CONFIDENCE_TIERS[0]).toBe('exact-local');
    expect(CONFIDENCE_TIERS[1]).toBe('transformed-local');
  });

  it('the auto-promotable tier is the single strongest proven tier', () => {
    // If this ever admits a second tier, promotion policy on the server changes meaning — the
    // constant is the contract, not a default someone may widen locally.
    expect(CAPABILITY_MANIFEST.autoPromotableConfidence).toBe('exact-local');
    expect(PROVEN_CONFIDENCE_TIERS).toContain(CAPABILITY_MANIFEST.autoPromotableConfidence);
  });

  it('candidate families are a subset of what the roles can support', () => {
    // Not a mechanical check of the mapping (that lives in sinks.ts) but of the vocabulary's shape:
    // every family must be expressible, i.e. narrower than the role list.
    expect(CANDIDATE_FAMILIES.length).toBeLessThan(ARGUMENT_ROLES.length);
  });

  it('has no duplicate members in any vocabulary', () => {
    for (const [name, list] of Object.entries(manifest)) {
      if (!Array.isArray(list)) continue;
      expect(new Set(list).size, `${name} has duplicates`).toBe(list.length);
    }
  });
});

describe('what the map emits stays inside the contract', () => {
  it('never produces a sink kind, role, family or tier outside the vocabulary', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ps-cap-'));
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { express: '4', pg: '8' } }));
    writeFileSync(join(d, 'src', 'app.ts'), `
      import express from "express";
      import { Pool } from "pg";
      import fs from "node:fs";
      import { exec } from "node:child_process";
      const pool = new Pool();
      const app = express();
      app.post("/q", (req, res) => { pool.query(req.body.sql); res.end("ok"); });
      app.post("/f", (req, res) => { fs.readFileSync(req.body.path); res.end("ok"); });
      app.post("/c", (req, res) => { exec(req.body.cmd); res.end("ok"); });
      app.post("/u", (req, res) => { fetch(req.body.url); res.end("ok"); });
    `);
    const { map } = await buildInputMap(d);
    const sinkKinds = new Set<string>();
    const roles = new Set<string>();
    const families = new Set<string>();
    const tiers = new Set<string>();
    for (const ep of map!.endpoints) {
      for (const s of ep.sinks) sinkKinds.add(s.kind);
      for (const f of ep.flows) {
        tiers.add(f.confidence);
        if (f.argumentRole) roles.add(f.argumentRole);
        if (f.candidateFamily) families.add(f.candidateFamily);
      }
    }
    // Non-vacuity first: a fixture that produced nothing would satisfy every assertion below.
    expect(sinkKinds.size).toBeGreaterThan(2);
    expect(families.size).toBeGreaterThan(0);
    for (const k of sinkKinds) expect(SINK_KINDS as readonly string[]).toContain(k);
    for (const r of roles) expect(ARGUMENT_ROLES as readonly string[]).toContain(r);
    for (const f of families) expect(CANDIDATE_FAMILIES as readonly string[]).toContain(f);
    for (const t of tiers) expect(CONFIDENCE_TIERS as readonly string[]).toContain(t);
    // And the import inventory's recognizedSinkKinds draw from the same vocabulary.
    for (const dep of map!.imports ?? []) {
      for (const k of dep.recognizedSinkKinds) expect(SINK_KINDS as readonly string[]).toContain(k);
    }
    rmSync(d, { recursive: true, force: true });
  });
});

// A declared capability with no recognizer behind it is a silent hole: the vocabulary accepts it, every
// consumer accepts it, and no flow of that kind is ever emitted — so the rule family it unlocks can never
// fire. The existing "everything emitted falls inside the vocabulary" test cannot see it, because it only
// proves the kinds that DO emit are legal. This is the other direction: every kind we declare must be
// emitted by its own control.
describe('every declared capability has a recognizer behind it', () => {
  const build = async (kind: string, ctl: (typeof CAPABILITY_CONTROLS)[keyof typeof CAPABILITY_CONTROLS]) => {
    const d = mkdtempSync(join(tmpdir(), `ps-ctl-${kind}-`));
    mkdirSync(join(d, 'src'), { recursive: true });
    const deps: Record<string, string> = { express: '4' };
    for (const dep of ctl.deps) deps[dep] = '*';
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: deps }));
    writeFileSync(join(d, 'src', 'app.ts'), [
      'import express from "express";',
      ctl.setup,
      'const app = express();',
      `app.post("/${kind}", (req, res) => { ${ctl.control} res.end("ok"); });`,
    ].join('\n'));
    const { map } = await buildInputMap(d);
    rmSync(d, { recursive: true, force: true });
    return map!;
  };

  it('names a control for every sink kind — enforced by the type, verified here', () => {
    // Record<SinkKind, …> already makes a missing control a compile error; this asserts the runtime
    // object matches too, so a cast or a merge accident cannot slip past.
    expect(Object.keys(CAPABILITY_CONTROLS).sort()).toEqual([...SINK_KINDS].sort());
  });

  for (const kind of SINK_KINDS) {
    const ctl = CAPABILITY_CONTROLS[kind];

    it(`emits a '${kind}' sink from its own control fixture`, async () => {
      const map = await build(kind, ctl);
      const kinds = map.endpoints.flatMap((e) => e.sinks.map((s) => s.kind));
      expect(kinds, `control for '${kind}' produced ${JSON.stringify(kinds)}`).toContain(kind);
    });

    if (ctl.ruleGeneratable) {
      it(`compiles a candidate from a proven '${kind}' flow`, async () => {
        const map = await build(kind, ctl);
        const flows = map.endpoints.flatMap((e) => e.flows).filter((f) => f.sink.kind === kind);
        expect(flows.length, `no flow reached the '${kind}' sink`).toBeGreaterThan(0);
        const generatable = flows.filter((f) => f.ruleGeneratable);
        expect(generatable.length, `'${kind}' is declared rule-generatable but compiled nothing`).toBeGreaterThan(0);
        // EQUALITY, not membership. "Some candidate with some family" would accept a recognizer that
        // classified this flow as the wrong mitigation class — a rule inspecting the wrong thing, and
        // blocking the wrong traffic, with the suite still green.
        for (const f of generatable) {
          expect(f.argumentRole, `'${kind}' candidate role`).toBe(ctl.expectRole);
          expect(f.candidateFamily, `'${kind}' candidate family`).toBe(ctl.expectFamily);
        }
      });
    }
  }

  it('names an existing adversarial case for every rule-generatable capability', () => {
    // The link is declaration-to-declaration: a named id that must resolve to a real case. The previous
    // version searched the corpus file for the API name, which a comment or an unrelated positive fixture
    // satisfied just as well — coverage that could be true by coincidence.
    const byId = new Map(ADVERSARIAL.map((c) => [c.id, c]));
    for (const kind of SINK_KINDS) {
      const ctl = CAPABILITY_CONTROLS[kind];
      if (!ctl.ruleGeneratable) continue;
      const c = byId.get(ctl.adversarialCaseId);
      expect(c, `'${kind}' names adversarial case '${ctl.adversarialCaseId}', which does not exist`).toBeDefined();
      expect(c!.kind, `'${ctl.adversarialCaseId}' is not in the adversarial category`).toBe('adversarial');
      // An adversarial case that expects candidates cannot be evidence that a lookalike compiles nothing.
      expect(c!.expectCandidates, `'${ctl.adversarialCaseId}' expects candidates`).toEqual([]);
    }
  });

  it('and that case really compiles nothing while still showing a surface', async () => {
    // The declaration says it expects no candidates; this builds it and checks the extractor agrees —
    // plus the corpus non-vacuity rule, since a case that detects nothing at all would satisfy a
    // zero-candidate assertion for the wrong reason.
    const ids = new Set(
      SINK_KINDS.map((k) => CAPABILITY_CONTROLS[k]).filter((c) => c.ruleGeneratable)
        .map((c) => (c as Extract<typeof c, { ruleGeneratable: true }>).adversarialCaseId),
    );
    for (const id of ids) {
      const c = ADVERSARIAL.find((x) => x.id === id)!;
      const d = mkdtempSync(join(tmpdir(), 'ps-adv-'));
      for (const [rel, body] of Object.entries(c.files)) {
        mkdirSync(join(d, rel, '..'), { recursive: true });
        writeFileSync(join(d, rel), body);
      }
      writeFileSync(join(d, 'package.json'), JSON.stringify(c.pkg));
      const { map } = await buildInputMap(d);
      const candidates = map!.endpoints.flatMap((e) => e.flows).filter((f) => f.ruleGeneratable);
      expect(candidates.map((f) => f.candidateFamily), `${id} compiled a candidate`).toEqual([]);
      const inputs = map!.endpoints.flatMap((e) => e.inputs);
      expect(inputs.length, `${id} detected no surface at all — the zero-candidate result is vacuous`)
        .toBeGreaterThan(0);
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

});
/**
 * Every vocabulary declared here must actually reach the manifest consumers vendor.
 *
 * This was found the hard way: `INPUT_SOURCES` was added to `CAPABILITY_MANIFEST` and did not appear in
 * `capabilities.json`, because the emitter assembles the JSON from its OWN restated list of vocabulary
 * names. `emit-capabilities --check` reported "up to date" the whole time — both sides omitted it, so they
 * agreed. A member could be added, typed, used, and never ship, and the check designed to catch exactly
 * that said nothing.
 *
 * Asserting over the source rather than over either list is the only version of this that cannot be
 * satisfied by two files agreeing to be wrong together.
 */
describe('the emitted manifest covers every declared vocabulary', () => {
  const source = readFileSync(join(root, 'src', 'map', 'capabilities.ts'), 'utf8');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // Exported `as const` arrays are the vocabularies. `CAPABILITY_MANIFEST` itself is the assembly, not a
  // member, and the scalar pins are read separately by the emitter.
  const declared = [...source.matchAll(/export const ([A-Z_]+) = \[/g)]
    .map((m) => m[1])
    .filter((name) => name !== 'CAPABILITY_MANIFEST');

  it('finds the vocabularies to check, so an empty list cannot pass', () => {
    expect(declared.length).toBeGreaterThanOrEqual(8);
  });

  it.each(declared)('%s appears in capabilities.json with the same members', (name) => {
    // camelCase key, as the manifest names them: SINK_KINDS → sinkKinds.
    const key = name.toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase());
    const members = [...(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`, 's').exec(source)?.[1] ?? '')
      .matchAll(/'([^']+)'/g)].map((m) => m[1]);

    expect(manifest, `${name} is declared but ${key} is absent from capabilities.json`).toHaveProperty(key);
    expect(manifest[key]).toEqual(members);
  });
});

