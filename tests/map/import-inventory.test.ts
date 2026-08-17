import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { scanFileImports } from '../../src/map/imports.js';
import type { ImportedPackage } from '../../src/map/types.js';

// The import inventory answers a question the sink list cannot: "does this app use package P at all?"
// A vulnerability correlator that asks the sink list instead gets "no sink for P" and reads it as "P is
// not reachable" — closing a real vulnerability. Two properties keep that from happening, and they are
// what this file guards: the inventory must cover files with NO entry point (where the data layer of an
// AI-built app usually lives), and it must say out loud when a package's API is one the extractor has no
// model for.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-imports-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { express: '4', pg: '8', decompress: '4', lodash: '4' },
  }));
  // No entry-point signal anywhere in this file: the pre-filter skips it before parsing, and it is
  // exactly where the interesting dependency is imported.
  writeFileSync(join(dir, 'src', 'lib.ts'), `
    import { Pool } from "pg";
    import merge from "lodash/merge";
    const decompress = require("decompress");
    export const pool = new Pool();
    export async function unpack(f: string) { return decompress(f, "/tmp/out") }
    export const cfg = (a: object, b: object) => merge(a, b);
  `);
  writeFileSync(join(dir, 'src', 'app.ts'), `
    import express from "express";
    import * as store from "./lib";
    import { readFileSync } from "node:fs";
    const app = express();
    app.post("/unpack", async (req, res) => { await store.unpack(req.body.archive); res.end("ok"); });
    app.post("/read", (req, res) => { res.end(readFileSync(req.body.path)); });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const inventory = async () => {
  const { map } = await buildInputMap(dir);
  const byName = new Map<string, ImportedPackage>();
  for (const d of map!.imports ?? []) byName.set(d.package, d);
  return byName;
};

describe('the import inventory covers the whole project', () => {
  it('records packages imported from a file with no entry point', async () => {
    const inv = await inventory();
    // `src/lib.ts` is pre-filtered — never parsed — yet its dependencies must still be known.
    expect(inv.get('pg')).toBeDefined();
    expect(inv.get('pg')!.sites[0]!.file).toBe('src/lib.ts');
    expect(inv.get('decompress')).toBeDefined();
  });

  it('keeps the specifier as written, so a subpath-scoped advisory can be matched', async () => {
    const inv = await inventory();
    // "only lodash/merge is affected" is a real advisory shape; the package root cannot express it.
    expect(inv.get('lodash')!.specifiers).toEqual(['lodash/merge']);
  });

  it('collects bound names from parsed files and admits when they are partial', async () => {
    const inv = await inventory();
    expect(inv.get('node:fs')!.names).toEqual(['readFileSync']);
    expect(inv.get('node:fs')!.namesComplete).toBe(true);
    // pg was only ever seen by the cheap scan, so its name set is a subset — never read absence as proof.
    expect(inv.get('pg')!.namesComplete).toBe(false);
  });

  it('excludes relative imports — app code is not a dependency', async () => {
    const inv = await inventory();
    expect([...inv.keys()].filter((k) => k.startsWith('.'))).toEqual([]);
    expect(inv.has('./lib')).toBe(false);
  });

  it('is deterministic and deduped across runs', async () => {
    const a = await inventory();
    const b = await inventory();
    expect([...a.keys()]).toEqual([...b.keys()]);
    expect([...a.keys()]).toEqual([...a.keys()].sort());
    expect(a.get('decompress')!.siteCount).toBe(1);
  });
});

describe('unmodelled is not unreachable', () => {
  it('marks a package the extractor has no sink recognizer for', async () => {
    const inv = await inventory();
    // `decompress` (zip-slip) is a real, exploitable dataflow shape — and not one of the API families
    // the extractor models. The map must not imply otherwise.
    expect(inv.get('decompress')!.recognizedSinkKinds).toEqual([]);
  });

  it('produces no sink for it, which is exactly why the marker has to exist', async () => {
    const { map } = await buildInputMap(dir);
    const ep = map!.endpoints.find((e) => e.route === '/unpack')!;
    // The endpoint reads an input and calls into the vulnerable package — and the map sees no sink.
    expect(ep.inputs.map((i) => i.name)).toContain('archive');
    expect(ep.sinks.filter((s) => s.package === 'decompress')).toEqual([]);
    // Without recognizedSinkKinds, a consumer correlating a `decompress` CVE against this endpoint would
    // find no flow and conclude "not reachable". The inventory is what turns that into "cannot tell".
    const dep = (map!.imports ?? []).find((d) => d.package === 'decompress')!;
    expect(dep.recognizedSinkKinds).toHaveLength(0);
    expect(dep.siteCount).toBeGreaterThan(0);
  });

  it('still reports the recognized families for packages it does model', async () => {
    const inv = await inventory();
    expect(inv.get('pg')!.recognizedSinkKinds).toEqual(['db']);
    expect(inv.get('node:fs')!.recognizedSinkKinds).toEqual(['fs']);
  });

  it('counts the unmodelled packages in the coverage notes', async () => {
    const { map } = await buildInputMap(dir);
    const note = map!.coverage.notes.find((n) => n.includes('recognizedSinkKinds: []'))!;
    expect(note).toBeDefined();
    expect(note).toMatch(/needs review/);
  });
});

describe('absence is only evidence when the inventory is complete', () => {
  it('reports the inventory as complete for a clean tree', async () => {
    const { map } = await buildInputMap(dir);
    expect(map!.coverage.importsComplete).toBe(true);
  });

  it('marks it incomplete when a file could not be analysed, and says so in the notes', async (ctx) => {
    const d = mkdtempSync(join(tmpdir(), 'ps-imp-partial-'));
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
    writeFileSync(join(d, 'src', 'ok.ts'), `
      import express from "express";
      const app = express();
      app.get("/ok", (req, res) => res.end("ok"));
    `);
    // The walker finds this file, reading it throws, and its imports are therefore UNKNOWN. A server
    // must not conclude "package P is not imported" from an inventory with a hole in it.
    const bad = join(d, 'src', 'secret.ts');
    writeFileSync(bad, 'import hidden from "hidden-package";');
    chmodSync(bad, 0o000);
    let unreadable = false;
    try { readFileSync(bad, 'utf8'); } catch { unreadable = true; }
    if (!unreadable) { rmSync(d, { recursive: true, force: true }); ctx.skip(); return; } // running as root

    const { map } = await buildInputMap(d);
    expect(map!.coverage.importsComplete).toBe(false);
    expect(map!.coverage.notes.some((n) => n.includes('import inventory is INCOMPLETE'))).toBe(true);
    // The point of the flag: the package really is missing from the inventory, so the flag is the only
    // thing standing between a hole in our analysis and a "not imported" conclusion.
    expect((map!.imports ?? []).map((p) => p.package)).not.toContain('hidden-package');
    chmodSync(bad, 0o644);
    rmSync(d, { recursive: true, force: true });
  });

  it('marks it incomplete when a directory could not be walked', async (ctx) => {
    const d = mkdtempSync(join(tmpdir(), 'ps-imp-dir-'));
    mkdirSync(join(d, 'src', 'locked'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
    writeFileSync(join(d, 'src', 'ok.ts'), `
      import express from "express";
      const app = express();
      app.get("/ok", (req, res) => res.end("ok"));
    `);
    writeFileSync(join(d, 'src', 'locked', 'hidden.ts'), 'import x from "hidden-package";');
    // An unreadable DIRECTORY is the quiet case: its files are never discovered, so filesDiscovered and
    // filesSkipped both stay silent and the tree merely looks smaller. Nothing but an explicit traversal
    // counter can notice — and without it the flag would certify an inventory missing a whole subtree.
    chmodSync(join(d, 'src', 'locked'), 0o000);
    let unwalkable = false;
    try { readdirSync(join(d, 'src', 'locked')); } catch { unwalkable = true; }
    if (!unwalkable) { chmodSync(join(d, 'src', 'locked'), 0o755); rmSync(d, { recursive: true, force: true }); ctx.skip(); return; }

    const { map } = await buildInputMap(d);
    expect(map!.coverage.pathsUnwalked).toBeGreaterThan(0);
    expect(map!.coverage.importsComplete).toBe(false);
    expect((map!.imports ?? []).map((p) => p.package)).not.toContain('hidden-package');
    // The give-away: the file counters look perfectly healthy while a subtree is missing.
    expect(map!.coverage.filesSkipped).toBe(0);
    chmodSync(join(d, 'src', 'locked'), 0o755);
    rmSync(d, { recursive: true, force: true });
  });

  it('reports a failed scan as unknown rather than as no imports', () => {
    // null, not [] — an empty array would say "this file imports nothing", which is a claim we cannot
    // make about a file we failed to read.
    const exploding = { preProcessFile() { throw new Error('boom'); } } as unknown as Parameters<typeof scanFileImports>[1];
    expect(scanFileImports('import x from "pg";', exploding)).toBeNull();
  });
});

describe('the document stays a v3 wire contract', () => {
  it('adds the inventory without bumping the version', async () => {
    const { map } = await buildInputMap(dir);
    // Additive-only: a v3 consumer that ignores `imports` is still correct, so bumping would break every
    // existing reader for no safety gain.
    expect(map!.version).toBe(3);
    expect(Array.isArray(map!.imports)).toBe(true);
  });
});

describe('a path alias is app code, not a dependency', () => {
  it('excludes tsconfig path aliases and bare non-package specifiers', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ps-imp-alias-'));
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
    // Comments and a trailing comma: the shape real tsconfigs ship in, which JSON.parse rejects.
    writeFileSync(join(d, 'tsconfig.json'), `{
      /* Bundler mode */
      "compilerOptions": {
        "strict": true, // on purpose
        "paths": { "@/*": ["./src/*"], "@app/*": ["./src/app/*"], },
      }
    }`);
    writeFileSync(join(d, 'src', 'aliased.ts'), `
      import express from "express";
      import { Button } from "@/components/button";
      import { thing } from "@app/thing";
      import { home } from "~/pages/home";
      const app = express();
      app.get("/a", (req, res) => res.end(Button + thing + home));
    `);
    const { map } = await buildInputMap(d);
    const pkgs = (map!.imports ?? []).map((x) => x.package);
    // `@app/*` is indistinguishable from a real scoped package by name alone — only the tsconfig says
    // otherwise, which is why the aliases are read rather than guessed.
    expect(pkgs).toEqual(['express']);
    rmSync(d, { recursive: true, force: true });
  });

  it('does not let a non-wildcard alias swallow a real package that shares its prefix', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ps-imp-wild-'));
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { express: '4', foobar: '1' } }));
    // `"foo"` aliases exactly one specifier. Treating it as a prefix would also exclude `foobar` —
    // a real dependency silently vanishing from the inventory, which is the failure mode this whole
    // file exists to prevent.
    writeFileSync(join(d, 'tsconfig.json'), '{"compilerOptions":{"paths":{"foo":["./src/foo.ts"],"@/*":["./src/*"]}}}');
    writeFileSync(join(d, 'src', 'w.ts'), `
      import express from "express";
      import x from "foo";
      import y from "foobar";
      import z from "@/util";
      const app = express();
      app.get("/w", (req, res) => res.end(String(x) + y + z));
    `);
    const { map } = await buildInputMap(d);
    expect((map!.imports ?? []).map((p) => p.package)).toEqual(['express', 'foobar']);
    rmSync(d, { recursive: true, force: true });
  });

  it('falls back to the name check when there is no tsconfig', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ps-imp-noalias-'));
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
    writeFileSync(join(d, 'src', 'bare.ts'), `
      import express from "express";
      import { Card } from "@/components/card";
      const app = express();
      app.get("/b", (req, res) => res.end(Card));
    `);
    const { map } = await buildInputMap(d);
    // `@/components` is not a legal npm name, so it is excluded even with no tsconfig to consult.
    expect((map!.imports ?? []).map((x) => x.package)).toEqual(['express']);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('import forms', () => {
  it('records require, dynamic import and re-export edges', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ps-imp-forms-'));
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
    writeFileSync(join(d, 'src', 'forms.ts'), `
      import express from "express";
      export { compile } from "handlebars";
      const yaml = require("js-yaml");
      const app = express();
      app.post("/x", async (req, res) => {
        const { render } = await import("ejs");
        res.end(yaml.load(req.body.doc) + render(""));
      });
    `);
    const { map } = await buildInputMap(d);
    const names = (map!.imports ?? []).map((x) => x.package);
    expect(names).toContain('handlebars');
    expect(names).toContain('js-yaml');
    expect(names).toContain('ejs');
    const ejs = (map!.imports ?? []).find((x) => x.package === 'ejs')!;
    expect(ejs.names).toEqual(['import()']);
    rmSync(d, { recursive: true, force: true });
  });

  it('does not report a specifier that only appears in a comment or string', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ps-imp-cmt-'));
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: {} }));
    // The cheap scan is token-accurate, not a grep — this file imports nothing.
    writeFileSync(join(d, 'src', 'notes.ts'), `
      // import lodash from "lodash";
      export const doc = 'require("pg")';
    `);
    const { map } = await buildInputMap(d);
    expect((map!.imports ?? []).map((x) => x.package)).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });
});
