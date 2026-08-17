import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import type { ApiInvocation } from '../../src/map/types.js';

// The invocation inventory exists for the advisories the sink analysis cannot see. The motivating case is
// real: sequelize CVE-2026-69240's own proof of concept is `Model.findOne({ where: { x: req.query.x } })`,
// and `findOne` is not a recognized sink operation — so that advisory's demonstration shape produced
// nothing at all, and the vulnerability could only ever be reported as "the package is imported".
//
// The discipline is the sink discipline: resolve the RECEIVER, never trust a method name. So most of this
// file is about what must NOT be recorded.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-inv-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { express: '4', sequelize: '6', lodash: '4', pg: '8' },
  }));
  // A client re-exported from a local module — the layout generated apps actually use.
  writeFileSync(join(dir, 'src', 'lib.ts'), `
    import { Pool } from "pg";
    export const pool = new Pool();
  `);
  writeFileSync(join(dir, 'src', 'server.ts'), `
    import express from "express";
    import { Sequelize } from "sequelize";
    import merge from "lodash/merge";
    import { pool } from "./lib";
    const sequelize = new Sequelize("oracle://x", { dialect: "oracle" });
    const Student = sequelize.define("Student", {});
    const app = express();
    app.get("/find", async (req, res) => {
      const found = await Student.findOne({ where: { firstName: req.query.firstName } });
      res.json(merge({}, found));
    });
    app.post("/raw", async (req, res) => {
      await pool.query(req.body.q);
      await Student.findOne({ where: { id: req.body.id } });
      res.end();
    });
    app.post("/lookalike", (req, res) => {
      // A dangerous-looking method on a receiver nothing can trace.
      res.locals.db.query(req.body.sql);
      res.end();
    });
  `);
  // A local function whose name collides with a dependency export.
  writeFileSync(join(dir, 'src', 'shadow.ts'), `
    import express from "express";
    function merge(a, b) { return { ...a, ...b } }
    const app = express();
    app.post("/shadow", (req, res) => { res.json(merge(req.body, {})); });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const inventory = async (): Promise<ApiInvocation[]> => {
  const { map } = await buildInputMap(dir);
  return map!.apiInvocations ?? [];
};
const find = (list: ApiInvocation[], pkg: string, symbol: string) =>
  list.find((i) => i.package === pkg && i.symbol === symbol);

describe('the invocation inventory answers what sinks cannot', () => {
  it('records a model method the sink analysis produces no sink for', async () => {
    const list = await inventory();
    const findOne = find(list, 'sequelize', 'findOne');

    expect(findOne, 'the advisory PoC shape must be visible here even though it is not a sink').toBeDefined();
    expect(findOne!.kind).toBe('member');
    expect(findOne!.callCount, 'called from two handlers').toBe(2);
  });

  it('confirms that same call really produces no sink, so the two layers are not redundant', async () => {
    const { map } = await buildInputMap(dir);
    const sinks = map!.endpoints.flatMap((e) => e.sinks).filter((s) => s.package === 'sequelize' && s.op === 'findOne');

    expect(sinks, 'if this ever becomes a sink, the motivating case for this layer changed').toEqual([]);
  });

  it('records a bare call from a named import under its exported name', async () => {
    const list = await inventory();
    const merge = find(list, 'lodash', 'merge');

    expect(merge).toBeDefined();
    expect(merge!.kind).toBe('call');
    expect(merge!.resolution).toBe('direct');
    expect(merge!.specifiers).toContain('lodash/merge');
  });

  it('records a construction', async () => {
    const list = await inventory();
    const sequelize = find(list, 'sequelize', 'Sequelize');

    expect(sequelize).toBeDefined();
    expect(sequelize!.kind).toBe('construct');
    expect(sequelize!.resolution).toBe('direct');
  });

  it('marks a value reached through a factory as such, rather than as a direct import', async () => {
    const list = await inventory();

    // `sequelize.define(...)` — the receiver came from `new Sequelize(...)`, not from the import itself.
    expect(find(list, 'sequelize', 'define')!.resolution).toBe('factory');
  });

  it('marks a dependency re-exported from a local module as a reexport', async () => {
    const list = await inventory();
    const query = find(list, 'pg', 'query');

    expect(query, 'a client imported from ./lib still belongs to its package').toBeDefined();
    expect(query!.resolution).toBe('reexport');
  });
});

describe('a method name is not an API', () => {
  it('does not record a call on a receiver it cannot trace', async () => {
    const list = await inventory();
    // `res.locals.db.query(...)` — `pg` is imported elsewhere in the project, and this is still not it.
    const fromUntraceable = list.filter((i) => i.symbol === 'query' && i.resolution !== 'reexport');

    expect(fromUntraceable, 'an untraceable receiver must not be attributed to a package').toEqual([]);
  });

  it('does not record a local function that shares a dependency export name', async () => {
    const list = await inventory();
    const merge = find(list, 'lodash', 'merge')!;

    // One call site, in server.ts. The `merge` in shadow.ts is app code that happens to share the name.
    expect(merge.callCount).toBe(1);
    expect(merge.sites.every((s) => s.file === 'src/server.ts')).toBe(true);
  });

  it('never claims an attribution other than a resolved import', async () => {
    const list = await inventory();

    expect(list.every((i) => i.attribution === 'import')).toBe(true);
  });

  it('omits the receiver when the receiver is the app’s own name for a value', async () => {
    const list = await inventory();
    // `Student` is what this app called the model; it is not part of sequelize's API, so reporting it as
    // one would be inventing an API name.
    expect(find(list, 'sequelize', 'findOne')!.receiver).toBeUndefined();
  });
});

describe('the inventory says plainly that it is partial', () => {
  it('carries the limitations, and no completeness flag of any kind', async () => {
    const { map } = await buildInputMap(dir);
    const coverage = map!.coverage as Record<string, unknown>;

    expect(Array.isArray(coverage.apiInventoryLimitations)).toBe(true);
    expect((coverage.apiInventoryLimitations as string[]).length).toBeGreaterThan(3);
    // No boolean a consumer could read as licence for "the vulnerable API is not called". Parsing more
    // files would raise recall without removing a single limitation, so completeness is not on offer.
    expect(coverage.apiInventoryComplete).toBeUndefined();
  });

  it('names the shapes that make absence meaningless', async () => {
    const { map } = await buildInputMap(dir);
    const limits = ((map!.coverage as Record<string, unknown>).apiInventoryLimitations as string[]).join(' ');

    expect(limits).toMatch(/computed callee/);
    expect(limits).toMatch(/dynamic import/);
    expect(limits).toMatch(/entry-point signal/);
  });

  it('warns in the notes that this is positive evidence only', async () => {
    const { map } = await buildInputMap(dir);

    expect(map!.coverage.notes.some((n) => n.includes('POSITIVE EVIDENCE ONLY'))).toBe(true);
  });
});

describe('the measurements needed to decide whether to parse more', () => {
  it('reports the cost and the four call buckets', async () => {
    const { map } = await buildInputMap(dir);
    const c = map!.coverage as Record<string, number>;

    expect(c.apiInvocations).toBeGreaterThan(0);
    expect(c.callsDependency).toBeGreaterThan(0);
    expect(c.sourceBytes).toBeGreaterThan(0);
    expect(c.analysisMs).toBeGreaterThanOrEqual(0);
    expect(c.filesParsed).toBeGreaterThan(0);
  });

  it('labels the two memory readings for what they actually are', async () => {
    const { map } = await buildInputMap(dir);
    const c = map!.coverage as Record<string, number>;

    // `rssBytes` is a point-in-time reading taken after extraction; calling it a peak would overstate it,
    // since the walk's garbage may already be collected. `peakRssBytes` is a real high-water mark from the
    // OS, but process-wide — it includes loading the TypeScript compiler — so it bounds the cost from above.
    if (c.rssBytes !== undefined && c.peakRssBytes !== undefined) {
      expect(c.peakRssBytes).toBeGreaterThanOrEqual(c.rssBytes);
    }
    expect(c.rssBytes ?? 1).toBeGreaterThan(0);
  });

  it('accounts for every call expression exactly once', async () => {
    const { map } = await buildInputMap(dir);
    const c = map!.coverage as Record<string, number>;

    // If the buckets do not sum, one of them is silently absorbing calls and every ratio built on them is
    // wrong in an unknown direction.
    expect(c.callsDependency + c.callsLocal + c.callsAmbiguous).toBe(c.callsTotal);
  });

  it('counts a local helper as local, not as a failure to resolve', async () => {
    // The measurement error this replaced: counting local calls as "unresolved" made the rate a property
    // of the app rather than of the resolver — and widening the parse would have LOWERED it by finding more
    // local calls, which is backwards for a number meant to justify widening the parse.
    const d = mkdtempSync(join(tmpdir(), 'ps-inv-local-'));
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
    writeFileSync(join(d, 'src', 'local.ts'), `
      import express from "express";
      function helper(x) { return x + 1 }
      const shape = { build: (x) => x };
      const app = express();
      app.post("/x", (req, res) => {
        helper(req.body.a);
        shape.build(req.body.b);
        res.json({ ok: true });   // a handler PARAMETER, not a dependency
      });
    `);
    const { map } = await buildInputMap(d);
    const c = map!.coverage as Record<string, number>;

    // helper(), shape.build(), res.json() — three local calls, none of them ambiguous.
    expect(c.callsLocal).toBeGreaterThanOrEqual(3);
    expect(c.callsAmbiguous).toBe(0);
    // And resolver quality is unaffected by how many local helpers the app happens to have.
    expect(c.callsDependency / (c.callsDependency + c.callsAmbiguous)).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });

  it('counts an untraceable receiver as ambiguous, because it is a real miss', async () => {
    const { map } = await buildInputMap(dir);
    const c = map!.coverage as Record<string, number>;

    // `res.locals.db.query(...)` in the fixture: we cannot say whether that is a dependency, so it counts
    // against resolver quality rather than being quietly filed as local.
    expect(c.callsAmbiguous).toBeGreaterThan(0);
  });

  it('counts every call site even though the sites list is capped', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ps-inv-cap-'));
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { express: '4', lodash: '4' } }));
    writeFileSync(join(d, 'src', 'many.ts'), `
      import express from "express";
      import merge from "lodash/merge";
      const app = express();
      app.post("/a", (req, res) => { res.json(merge({}, req.body)); });
      app.post("/b", (req, res) => { res.json(merge({}, req.body)); });
      app.post("/c", (req, res) => { res.json(merge({}, req.body)); });
      app.post("/d", (req, res) => { res.json(merge({}, req.body)); });
      app.post("/e", (req, res) => { res.json(merge({}, req.body)); });
    `);
    const { map } = await buildInputMap(d);
    const merge = (map!.apiInvocations ?? []).find((i) => i.symbol === 'merge')!;

    expect(merge.callCount).toBe(5);
    expect(merge.sites.length).toBeLessThanOrEqual(3);
    rmSync(d, { recursive: true, force: true });
  });
});
