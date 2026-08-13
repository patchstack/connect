import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

// The MEMBER-call companion to sink-attribution.test.ts (which covers bare calls).
// A dangerous METHOD NAME is not a dangerous API. `import * as helper from './util'` gives a receiver
// that is neither a local binding nor a package, and admitting it produced precise, auto-generatable
// command-injection / SQLi / path-traversal candidates for ordinary app code. The bare-call path already
// required justification; the member-call path did not — the same bug, one syntax over.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-attr-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
  // App code whose exported names collide with dangerous APIs.
  writeFileSync(join(dir, 'src', 'util.ts'), `
    export function exec(x: string) { return x.length }
    export function query(x: string) { return x }
    export function readFileSync(p: string) { return p }
  `);
  // A relative namespace helper that DOES reach a real sink — recall must survive the fix.
  writeFileSync(join(dir, 'src', 'store.ts'), `
    import fs from "node:fs";
    export function save(p: string) { return fs.writeFileSync(p, "x") }
  `);
  writeFileSync(join(dir, 'src', 'app.ts'), `
    import * as helper from "./util";
    import * as store from "./store";
    import express from "express";
    const app = express();
    app.post("/lookalike", (req, res) => {
      helper.exec(req.body.cmd);
      helper.query(req.body.sql);
      helper.readFileSync(req.body.path);
      res.end("ok");
    });
    app.post("/viaHelper", (req, res) => { store.save(req.body.p); res.end("ok"); });
    app.post("/untraceable", (req, res) => { res.locals.db.query(req.body.sql); res.end("ok"); });
  `);
  writeFileSync(join(dir, 'src', 'real.ts'), `
    import fs from "node:fs";
    import { exec } from "node:child_process";
    import express from "express";
    const app = express();
    app.post("/real", (req, res) => {
      fs.readFileSync(req.body.path);
      exec(req.body.cmd);
      res.end("ok");
    });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ep = async (route: string) => {
  const { map } = await buildInputMap(dir);
  return map!.endpoints.find((e) => e.route === route)!;
};

describe('member-call sinks require an attributable receiver', () => {
  it('does not treat a relative namespace helper as fs/exec/db', async () => {
    const e = await ep('/lookalike');
    expect(e.sinks).toEqual([]);
  });

  it('generates no candidate for it — the false-blocking-rule case', async () => {
    const e = await ep('/lookalike');
    // The inputs are still reported: the surface is real, the SINK was not.
    expect(e.inputs.map((i) => i.name).sort()).toEqual(['cmd', 'path', 'sql']);
    expect(e.flows.filter((f) => f.ruleGeneratable)).toEqual([]);
  });

  it('still follows that receiver into its module, so a real sink is not lost', async () => {
    const e = await ep('/viaHelper');
    const fsSink = e.sinks.find((s) => s.kind === 'fs');
    expect(fsSink).toBeDefined();
    expect(fsSink!.package).toBe('node:fs');
    expect(fsSink!.file).toBe('src/store.ts'); // attributed to where it actually lives
  });

  it('keeps an untraceable receiver in the inventory but refuses to auto-rule it', async () => {
    const e = await ep('/untraceable');
    const db = e.sinks.find((s) => s.kind === 'db');
    expect(db).toBeDefined();
    expect(db!.attribution).toBeUndefined();
    const flow = e.flows.find((f) => f.sink.kind === 'db')!;
    expect(flow.ruleGeneratable).toBe(false);
    expect(flow.ruleGeneratableReasons!.join(' ')).toMatch(/could not be traced to a dependency/);
  });

  it('leaves genuinely imported sinks fully generatable', async () => {
    const e = await ep('/real');
    expect(e.sinks.map((s) => `${s.kind}:${s.attribution}`).sort()).toEqual(['exec:import', 'fs:import']);
    const gen = e.flows.filter((f) => f.ruleGeneratable).map((f) => f.candidateFamily).sort();
    expect(gen).toEqual(['command-injection', 'path-traversal']);
  });
});

describe('sink identity is map-wide', () => {
  it('does not collide across two files with identical boilerplate at identical offsets', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ps-dup-'));
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
    // Byte-identical but for the route string, so every span matches.
    const src = (route: string) => `
      import express from "express";
      import fs from "node:fs";
      const app = express();
      app.post("${route}", (req, res) => { res.end(fs.readFileSync(req.body.f)); });
    `;
    writeFileSync(join(d, 'src', 'a.ts'), src('/aa'));
    writeFileSync(join(d, 'src', 'b.ts'), src('/bb'));
    const { map } = await buildInputMap(d);
    const ids = map!.endpoints.flatMap((e) => e.sinks.map((s) => s.id));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    rmSync(d, { recursive: true, force: true });
  });

  it('stays deterministic across runs', async () => {
    const a = await ep('/real');
    const b = await ep('/real');
    expect(a.sinks.map((s) => s.id)).toEqual(b.sinks.map((s) => s.id));
  });
});

// An INFERRED package is not evidence about the receiver. `res.locals.db.query(x)` in a file that
// happens to import `pg` was getting package "pg" and a precise SQL-injection candidate — the exact
// guarantee this file's first half claims to enforce, defeated by the fallback that fills in a package
// from the file's OTHER imports. Inferred sinks stay in the inventory; they never compile a rule.
describe('an inferred package does not license a rule', () => {
  let d: string;
  beforeAll(() => {
    d = mkdtempSync(join(tmpdir(), 'ps-infer-'));
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({
      dependencies: { express: '4', pg: '8', '@supabase/supabase-js': '2', '@prisma/client': '5' },
    }));
    writeFileSync(join(d, 'src', 'inferred.ts'), `
      import { Pool } from "pg";
      import { createClient } from "@supabase/supabase-js";
      import { PrismaClient } from "@prisma/client";
      import express from "express";
      const app = express();
      // Every receiver here is an app object the analyzer cannot trace.
      app.post("/raw", (req, res) => { res.locals.db.query(req.body.sql); res.end("ok"); });
      app.post("/from", (req, res) => { res.locals.sb.from("t").insert({ v: req.body.v }); res.end("ok"); });
      app.post("/prisma", (req, res) => { res.locals.prisma.user.update({ where: { id: req.body.id } }); res.end("ok"); });
    `);
    // Controls: receivers that really do resolve to the dependency.
    writeFileSync(join(d, 'src', 'resolved.ts'), `
      import { Pool } from "pg";
      import { createClient } from "@supabase/supabase-js";
      import express from "express";
      const pool = new Pool();
      const sb = createClient("u", "k");
      const app = express();
      app.post("/pool", (req, res) => { pool.query(req.body.sql); res.end("ok"); });
      app.post("/sb", (req, res) => { sb.from("t").insert({ v: req.body.v }); res.end("ok"); });
    `);
  });
  afterAll(() => rmSync(d, { recursive: true, force: true }));

  const route = async (r: string) => {
    const { map } = await buildInputMap(d);
    return map!.endpoints.find((e) => e.route === r)!;
  };

  it('refuses a rule for an untraceable receiver even when the file imports a db package', async () => {
    const e = await route('/raw');
    const sink = e.sinks.find((s) => s.kind === 'db')!;
    // Note WHICH package inference picks: the first known db package the file imports, in table order —
    // here supabase, not the `pg` a reader would guess from `.query()`. A useful hint for a human
    // reviewer, and a good illustration of why it must not address a rule.
    expect(sink.package).toBe('@supabase/supabase-js');
    expect(sink.attribution).toBe('inferred');
    const flow = e.flows.find((f) => f.sink.kind === 'db')!;
    expect(flow.confidence).toBe('precise');   // the data really does reach it
    expect(flow.ruleGeneratable).toBe(false);  // and it still must not be auto-ruled
    expect(flow.ruleGeneratableReasons!.join(' ')).toMatch(/inferred from the file's other imports/);
  });

  it('refuses the same for an untraceable .from().insert() receiver', async () => {
    const e = await route('/from');
    const sink = e.sinks.find((s) => s.kind === 'db')!;
    expect(sink.attribution).toBe('inferred');
    const flow = e.flows.find((f) => f.sink.kind === 'db')!;
    expect(flow.ruleGeneratable).toBe(false);
    // Assert the ATTRIBUTION reason specifically: this shape is also refused for its argument role
    // ("values"), so without this the fixture would pass for the wrong reason and regress silently.
    expect(flow.ruleGeneratableReasons!.join(' ')).toMatch(/inferred from the file's other imports/);
  });

  it('refuses the prisma-shaped path on an untraceable receiver', async () => {
    const e = await route('/prisma');
    const sink = e.sinks.find((s) => s.provider === 'prisma');
    expect(sink?.attribution).toBe('inferred');
    expect(e.flows.filter((f) => f.ruleGeneratable)).toEqual([]);
  });

  it('still generates for receivers that genuinely resolve to the dependency', async () => {
    const pool = await route('/pool');
    const sink = pool.sinks.find((s) => s.kind === 'db')!;
    expect(sink.attribution).toBe('import');
    const flow = pool.flows.find((f) => f.sink.kind === 'db')!;
    expect(flow.ruleGeneratable).toBe(true);
    expect(flow.candidateFamily).toBe('sql-injection');
    // And the resolved supabase receiver keeps its (separate, role-based) refusal — unchanged.
    const sb = await route('/sb');
    expect(sb.sinks.find((s) => s.kind === 'db')!.attribution).toBe('import');
  });
});
