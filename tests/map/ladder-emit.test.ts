import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { LADDER_CASES, type LadderCase } from './ladder-cases.js';

// Regeneration entry point for the ladder maps a CONSUMER checks in and grades.
//
// The platform stores these five documents as fixtures and asserts what each one grades to. They are
// generated artifacts, and until this existed they had no generator: the ladder suite builds each app in a
// temp directory, asserts, and deletes it. So the consumer's copies could only be reproduced by hand, and
// nothing detected them going stale — a fixture older than this extractor still parses and still grades, it
// just answers for an app the extractor now reads differently.
//
// Why a spec rather than a script in `scripts/`: `src/map/*` imports with ESM `.js` specifiers that point at
// `.ts` sources, so plain `node` cannot load it and a script would have to run against a build. Living here
// also keeps the emitter beside the app definitions it emits, which is the drift this is meant to prevent.
//
// Run:
//   PS_LADDER_EMIT_DIR=/path/to/back/tests/Fixtures/ReachabilityLadder npx vitest run tests/map/ladder-emit
//
// Skipped otherwise, so a normal suite run neither writes files nor needs a directory.

const OUT = process.env.PS_LADDER_EMIT_DIR;

/**
 * Per-machine measurements. They carry no contract, and leaving them in would make every regeneration a
 * diff on noise — which is how a regeneration step stops being run.
 */
const VOLATILE = ['analysisMs', 'rssBytes', 'peakRssBytes'] as const;

/** The consumer's on-disk form: two-space JSON with a trailing newline. Byte-identical or it diffs. */
function serialize(document: unknown): string {
  return JSON.stringify(document, null, 2) + '\n';
}

async function mapFor(c: LadderCase): Promise<Record<string, any>> {
  const dir = mkdtempSync(join(tmpdir(), 'ps-ladder-emit-'));
  try {
    for (const [rel, body] of Object.entries(c.files)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(c.packageJson));

    const { map, error } = await buildInputMap(dir);
    expect(error, `${c.id} must produce a map`).toBeUndefined();
    const document = map as Record<string, any>;
    for (const field of VOLATILE) delete document.coverage[field];

    return document;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The rung/advisory/package pairing, so a consumer can key its expectations off this rather than restate it. */
function manifest(): Record<string, unknown> {
  return {
    note: 'Generated from the ladder fixture apps. Do not edit; regenerate.',
    cases: LADDER_CASES.map((c) => ({ id: c.id, rung: c.rung, cve: c.cve, package: c.pkg, name: c.name })),
  };
}

describe.skipIf(!OUT)('emitting the ladder maps for a consumer', () => {
  it('writes one document per rung, plus the rung/advisory manifest', async () => {
    const written: string[] = [];
    for (const c of LADDER_CASES) {
      const file = c.id.replace('ladder/', '') + '.json';
      writeFileSync(join(OUT!, file), serialize(await mapFor(c)));
      written.push(file);
    }
    writeFileSync(join(OUT!, 'manifest.json'), serialize(manifest()));

    expect(written).toHaveLength(LADDER_CASES.length);
    console.log(`[ladder] wrote ${written.join(', ')} and manifest.json to ${OUT}`);
  });
});

describe('the emitter agrees with what it emits', () => {
  // The emitter's value is that its output can be committed elsewhere and trusted. Two properties make that
  // true, and both are cheap to assert without writing anything: the volatile fields really are gone (a
  // machine-specific number in a committed fixture makes every regeneration a diff), and the document still
  // carries the blocks the consumer's controls check — a map missing them grades LOWER rather than failing,
  // so an emitter that quietly dropped one would produce fixtures that pass as conservative verdicts.
  it('emits documents with no per-machine fields and both evidence blocks intact', async () => {
    const document = await mapFor(LADDER_CASES[0]);

    for (const field of VOLATILE) expect(document.coverage).not.toHaveProperty(field);
    expect(document.version).toBe(3);
    expect(Array.isArray(document.imports)).toBe(true);
    expect(Array.isArray(document.apiInvocations)).toBe(true);
    expect(document.coverage.importsComplete).toBeDefined();
    expect(document.coverage.filesParsed).toBeGreaterThan(0);
  });

  it('serializes exactly as the consumer stores it', () => {
    // Formatting is part of the contract here: a different indent or a missing trailing newline rewrites
    // every line of every fixture and buries the one change that mattered.
    expect(serialize({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it('names every case in the manifest, with its rung and advisory', () => {
    const cases = manifest().cases as Array<Record<string, string>>;

    expect(cases).toHaveLength(LADDER_CASES.length);
    for (const entry of cases) {
      expect(entry.id).toMatch(/^ladder\//);
      expect(entry.cve).toMatch(/^CVE-/);
      expect(entry.package).not.toBe('');
    }
  });
});
