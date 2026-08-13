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
