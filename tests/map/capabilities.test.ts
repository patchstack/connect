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
        // A candidate with no family cannot be turned into a rule, so the claim would be hollow.
        for (const f of generatable) {
          expect(f.candidateFamily, `'${kind}' candidate has no candidateFamily`).toBeDefined();
          expect(CANDIDATE_FAMILIES as readonly string[]).toContain(f.candidateFamily!);
        }
      });
    }
  }

  it('requires adversarial coverage for every rule-generatable capability', () => {
    // A capability that can compile a rule can also compile a WRONG rule, and every wrong-pin bug we
    // have found came from code that merely resembled a dangerous API. So the lookalike case is a
    // precondition for rule generation, not an optional extra: this asserts the adversarial corpus
    // actually exercises each such kind rather than trusting that it does.
    const corpus = readFileSync(join(root, 'tests/map/corpus.test.ts'), 'utf8');
    const adversarial = corpus.slice(corpus.indexOf('const ADVERSARIAL'), corpus.indexOf('const STACKS'));
    expect(adversarial.length, 'could not locate the adversarial corpus block').toBeGreaterThan(200);
    const missing = (Object.keys(CAPABILITY_CONTROLS) as Array<keyof typeof CAPABILITY_CONTROLS>)
      .filter((kind) => CAPABILITY_CONTROLS[kind].ruleGeneratable)
      // The lookalike is written in the app's own vocabulary, so match on the API the control calls
      // (`query`, `readFileSync`, `exec`, `fetch`, `eval`) rather than on the kind's name.
      .filter((kind) => {
        const api = /([A-Za-z_$][\w$]*)\s*\(/.exec(CAPABILITY_CONTROLS[kind].control);
        const needle = api ? api[1]!.split('.').pop()! : kind;
        return !adversarial.includes(needle);
      });
    expect(missing, `rule-generatable capabilities with no adversarial lookalike: ${missing.join(', ')}`).toEqual([]);
  });
});
