import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

/**
 * A directory skipped BY NAME must not silently license a negative.
 *
 * `coverage.importsComplete` is the one field that lets a consumer read a package's absence as "not
 * imported". It was computed from unreadable files, unscannable files and unwalked paths — none of which
 * a skip by name touches. So an app whose server lived under `vendor/` was indistinguishable from an app
 * with no such directory: the inventory omitted the package AND reported itself complete, and a consumer
 * holding the documented contract would close a live vulnerability as unreachable.
 *
 * The exclusion list (`dist`, `build`, `out`, `coverage`, `public`, `static`, `assets`, `vendor`, `tmp`,
 * `temp`, `__pycache__`) is a GUESS about where app source lives. `node_modules` is the exception, and the
 * distinction is the point of this suite: excluding it is definitional, so it must NOT forfeit the claim.
 */
function project(files: Record<string, string>, deps: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-skip-'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'x', dependencies: { express: '4.18.0', 'node-serialize': '0.0.4', ...deps } }),
  );
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }

  return dir;
}

// A real server: an endpoint, and an import of a package with a public RCE advisory.
const HIDDEN_SERVER =
  "import express from 'express';\nimport { unserialize } from 'node-serialize';\n"
  + "const app = express();\napp.post('/v', (req, res) => { res.end(String(unserialize(req.body.p))); });\n";

const VISIBLE_SERVER =
  "import express from 'express';\nconst app = express();\napp.post('/i', (req, res) => { res.end(String(req.body.a)); });\n";

describe('a guessed skip that hid source', () => {
  it('forfeits importsComplete and names the directory', async () => {
    const dir = project({ 'src/server.ts': VISIBLE_SERVER, 'vendor/server.ts': HIDDEN_SERVER });
    try {
      const { map } = await buildInputMap(dir, {});

      // The inventory genuinely cannot see it — that part is a limit of the skip list, not a bug.
      expect((map!.imports ?? []).map((i) => i.package)).not.toContain('node-serialize');
      // What must never happen is claiming completeness anyway.
      expect(map!.coverage.importsComplete).toBe(false);
      expect(map!.coverage.importCoverageGaps?.skippedDirsWithSource).toEqual(['vendor']);
      // Named, not just counted: a reader has to know WHICH guess to check, or the only move left is to
      // re-run the scan and read the identical silence.
      expect(map!.coverage.notes.join(' ')).toContain('vendor');
      // And named REPO-RELATIVELY. The walk compares against a realpath, so the obvious relativization
      // produced a `../../..` escape carrying the user's home directory — which this document is uploaded
      // to a server. Asserting only that 'vendor' appears passes either way, so assert the leak instead:
      // no value anywhere in the document may contain the absolute fixture path.
      expect(JSON.stringify(map)).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports every such directory, not only the first', async () => {
    const dir = project({
      'src/server.ts': VISIBLE_SERVER,
      'vendor/server.ts': HIDDEN_SERVER,
      'build/nested/deep/handler.js': HIDDEN_SERVER,
    });
    try {
      const { map } = await buildInputMap(dir, {});

      expect(map!.coverage.importCoverageGaps?.skippedDirsWithSource?.sort()).toEqual(['build', 'vendor']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is the ONLY difference from the same project without it — the positive control', async () => {
    // Without this the suite cannot tell "the flag responds to a hidden directory" from "the flag is
    // false for this fixture for some other reason".
    const dir = project({ 'src/server.ts': VISIBLE_SERVER });
    try {
      const { map } = await buildInputMap(dir, {});

      expect(map!.coverage.importsComplete).toBe(true);
      expect(map!.coverage.importCoverageGaps?.skippedDirsWithSource).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a skip that is not a guess', () => {
  it('does not forfeit completeness for node_modules', async () => {
    // Excluding `node_modules` is definitional: this inventory is of the app's OWN imports. If it counted,
    // `importsComplete` would be false for every project that has ever run `npm install` — a flag that is
    // always false conveys nothing and gets ignored, which is how the original defect stays alive.
    const dir = project({
      'src/server.ts': VISIBLE_SERVER,
      'node_modules/node-serialize/index.js': HIDDEN_SERVER,
    });
    try {
      const { map } = await buildInputMap(dir, {});

      expect(map!.coverage.importsComplete).toBe(true);
      expect(map!.coverage.importCoverageGaps?.skippedDirsWithSource).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not forfeit completeness for a dot-directory', async () => {
    // `.next`, `.output`, `.vercel`: build products by convention, and the walk skips every dot-directory
    // wholesale. Pinned so the deliberate scope is visible rather than incidental.
    const dir = project({ 'src/server.ts': VISIBLE_SERVER, '.next/server/app.js': HIDDEN_SERVER });
    try {
      const { map } = await buildInputMap(dir, {});

      expect(map!.coverage.importsComplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not forfeit completeness for a skipped directory holding no source', async () => {
    // The common real case: a committed `dist` of built assets. Charging it would make the flag useless.
    const dir = project({
      'src/server.ts': VISIBLE_SERVER,
      'dist/app.css': 'body{}',
      'dist/meta.json': '{}',
      'public/logo.svg': '<svg/>',
    });
    try {
      const { map } = await buildInputMap(dir, {});

      expect(map!.coverage.importsComplete).toBe(true);
      expect(map!.coverage.importCoverageGaps?.skippedDirsWithSource).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a skip that could not be settled', () => {
  it('counts a probe that ran out of budget as a gap, not as "no source"', async () => {
    // A large vendored tree of non-source files exhausts the probe before it can conclude anything. The
    // budget exists so the probe cannot cost more than the walk it is protecting; the answer it produces
    // on exhaustion is the whole point — "we stopped looking" must not be recorded as "nothing there",
    // which is the same silent-negative the suite exists to prevent, one level down.
    const dir = project({ 'src/server.ts': VISIBLE_SERVER });
    try {
      const noise = path.join(dir, 'vendor', 'blobs');
      mkdirSync(noise, { recursive: true });
      // Above PROBE_BUDGET (4096), and deliberately not source files.
      for (let i = 0; i < 4200; i++) writeFileSync(path.join(noise, `blob-${i}.bin`), 'x');

      const { map } = await buildInputMap(dir, {});

      expect(map!.coverage.importCoverageGaps?.skippedDirsUnsettled).toBeGreaterThan(0);
      expect(map!.coverage.importsComplete).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a directory it could not read as a gap rather than as an answer', async () => {
    const dir = project({ 'src/server.ts': VISIBLE_SERVER, 'vendor/keep.txt': 'x' });
    const vendor = path.join(dir, 'vendor');
    try {
      chmodSync(vendor, 0o000);
      const { map } = await buildInputMap(dir, {});

      // Unreadable: it may hold a server or nothing, and the two must not collapse into "nothing".
      expect(map!.coverage.importCoverageGaps?.skippedDirsUnsettled).toBeGreaterThan(0);
      expect(map!.coverage.importsComplete).toBe(false);
      expect(map!.coverage.notes.join(' ')).toContain('stopped looking');
    } finally {
      chmodSync(vendor, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
