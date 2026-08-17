import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { isProvenFlow } from '../../src/map/coordinates.js';
import type { SiteInputMap } from '../../src/map/types.js';

// GOLDEN CORPUS. Unit fixtures prove a mechanism; this measures BEHAVIOUR across the stacks AI builders
// actually generate, and enforces the metric that governs whether auto-generated rules are safe:
//
//     an auto-generated parameter-pinned rule must target the wrong input at a rate of ZERO.
//
// Each case declares the candidates it expects (family + the exact runtime parameter) and the flows that
// must NOT become candidates. Two failure modes are then measured separately:
//   - WRONG-INPUT: a candidate exists that nobody declared → the rule would pin the wrong parameter.
//     This must be 0. It is the metric.
//   - MISSED: a declared candidate is absent → recall gap. Reported, and asserted per-case so a
//     regression is loud, but it is a lesser sin than a wrong pin.
// Every production false positive we ever find should become a permanent case here.

// The cases live in `corpus-cases.ts` so other suites can reference a specific one by id — see
// `CAPABILITY_CONTROLS`, which names the adversarial case that covers each rule-generatable capability.
import { ADVERSARIAL, CASES, type Case } from './corpus-cases.js';

const ALL: Case[] = [...CASES, ...ADVERSARIAL];

const maps = new Map<string, SiteInputMap>();
let dirs: string[] = [];

beforeAll(async () => {
  for (const c of ALL) {
    const d = mkdtempSync(join(tmpdir(), 'ps-corpus-'));
    dirs.push(d);
    for (const [rel, body] of Object.entries(c.files)) {
      const p = join(d, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, body);
    }
    writeFileSync(join(d, 'package.json'), JSON.stringify(c.pkg));
    const { map, error } = await buildInputMap(d);
    expect(error, `${c.name}: ${error}`).toBeUndefined();
    maps.set(c.id, map!);
  }
}, 120_000);
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * Every compiled candidate as `family @ runtimeParameter`. Correlation is by input IDENTITY: keying this
 * by name would collapse `get:id` and `post:id` into one entry — the same lossy key that caused the
 * wrong-pin bugs, which would make the harness report the wrong coordinate for a correct candidate.
 */
function candidatesOf(map: SiteInputMap): string[] {
  const out: string[] = [];
  for (const ep of map.endpoints) {
    const coord = new Map(ep.inputs.map((i) => [i.id, i.runtimeParameter]));
    for (const f of ep.flows) {
      if (!f.ruleGeneratable) continue;
      out.push(`${f.candidateFamily} @ ${coord.get(f.inputId)}`);
    }
  }
  return out.sort();
}

describe('golden corpus', () => {
  for (const c of ALL) {
    describe(c.name, () => {
      it('compiles exactly the expected candidates — no wrong-input pins', () => {
        const got = candidatesOf(maps.get(c.id)!);
        const want = [...c.expectCandidates].sort();
        // A candidate nobody declared is a WRONG-INPUT pin: the metric that must stay at zero.
        expect(got.filter((g) => !want.includes(g)), 'unexpected candidate(s)').toEqual([]);
        expect(got).toEqual(want); // and no silent recall loss
      });

      it('refuses the flows that are proven but not blockable, with a reason', () => {
        const map = maps.get(c.id)!;
        for (const [input, reason] of c.expectRefused ?? []) {
          const flows = map.endpoints.flatMap((e) => e.flows).filter((f) => f.input === input);
          expect(flows.length, `no flow for input ${input}`).toBeGreaterThan(0);
          const refused = flows.filter((f) => f.ruleGeneratable === false);
          expect(refused.length).toBeGreaterThan(0);
          expect(refused.map((f) => (f.ruleGeneratableReasons ?? []).join(' ')).join(' ')).toMatch(reason);
        }
      });

      it('never emits a candidate whose input lacks a runtime coordinate', () => {
        const map = maps.get(c.id)!;
        for (const ep of map.endpoints) {
          const coord = new Map(ep.inputs.map((i) => [i.id, i.runtimeParameter]));
          for (const f of ep.flows.filter((x) => x.ruleGeneratable)) {
            expect(coord.get(f.inputId), `${f.inputId} is a candidate without a coordinate`).toBeTruthy();
          }
        }
      });

      it('gives every input a unique identity, and every flow a real one to point at', () => {
        const map = maps.get(c.id)!;
        for (const ep of map.endpoints) {
          const ids = ep.inputs.map((i) => i.id);
          expect(new Set(ids).size, `${ep.route ?? ep.name}: duplicate input ids`).toBe(ids.length);
          for (const f of ep.flows) expect(ids, `flow points at unknown input ${f.inputId}`).toContain(f.inputId);
        }
      });
    });
  }

  // An adversarial case that found NOTHING would pass its zero-candidate assertion for the wrong
  // reason — a parser bug or a bad fixture would read as a security property. Each one has to prove it
  // actually saw the handler and the request fields, and only then that it compiled no rule.
  it('adversarial cases detect a real surface and still refuse to compile a rule', () => {
    for (const c of ADVERSARIAL) {
      const map = maps.get(c.id)!;
      const inputs = map.endpoints.flatMap((e) => e.inputs);
      expect(map.endpoints.length, `${c.name}: no endpoint detected — the fixture proves nothing`).toBeGreaterThan(0);
      expect(inputs.length, `${c.name}: no inputs detected — the fixture proves nothing`).toBeGreaterThan(0);
      const generatable = map.endpoints.flatMap((e) => e.flows).filter((f) => f.ruleGeneratable);
      const declared = new Set(c.expectCandidates);
      const coord = new Map(map.endpoints.flatMap((e) => e.inputs).map((i) => [i.id, i.runtimeParameter]));
      expect(generatable.filter((f) => !declared.has(`${f.candidateFamily} @ ${coord.get(f.inputId)}`))).toEqual([]);
    }
  });

  it('keeps a standing adversarial category (lookalikes are how every false candidate got in)', () => {
    // Guards against the category quietly emptying out; the classes listed are the ones that have
    // actually produced false candidates, so losing one should fail loudly.
    expect(ADVERSARIAL.length).toBeGreaterThanOrEqual(7);
    const names = ADVERSARIAL.map((c) => c.name).join(' | ');
    for (const cls of ['collide with dangerous API names', 'untraceable receivers', 'shadowing dangerous globals', 'two request namespaces', 'sibling expressions', 'different namespaces', 'does not establish the API']) {
      expect(names, `missing adversarial class: ${cls}`).toContain(cls);
    }
  });

  it('reports corpus-wide metrics (the numbers that gate auto-promotion)', () => {
    let candidates = 0, refusedWithReason = 0, noCoordinate = 0;
    const tiers = new Map<string, number>();
    for (const c of ALL) {
      for (const ep of maps.get(c.id)!.endpoints) {
        for (const i of ep.inputs) if (!i.runtimeParameter) noCoordinate++;
        for (const f of ep.flows) {
          tiers.set(f.confidence, (tiers.get(f.confidence) ?? 0) + 1);
          if (f.ruleGeneratable) candidates++;
          else if ((f.ruleGeneratableReasons ?? []).length > 0) refusedWithReason++;
        }
      }
    }
    // eslint-disable-next-line no-console
    const byTier = [...tiers].sort().map(([t, n]) => `${n} ${t}`).join(', ');
    console.log(`corpus: ${CASES.length} stack + ${ADVERSARIAL.length} adversarial projects · ${candidates} candidates · flows: ${byTier} · ${refusedWithReason} refused-with-reason · ${noCoordinate} inputs without a coordinate`);
    expect(candidates).toBeGreaterThan(0);          // the compiler does something
    expect(refusedWithReason).toBeGreaterThan(0);   // and refuses a lot, explicitly
    // Every non-candidate must explain itself: silence is what makes a map untrustworthy.
    for (const c of ALL) {
      for (const ep of maps.get(c.id)!.endpoints) {
        for (const f of ep.flows.filter((x) => x.ruleGeneratable === false)) {
          expect(f.ruleGeneratableReasons?.length, `${c.name}/${f.input}: refused without a reason`).toBeGreaterThan(0);
        }
      }
    }
  });
});
