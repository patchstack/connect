import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

// The client almost never lives in the handler's file. Generated apps put it in `lib/db.ts` and import
// it everywhere, so the receiver of `db.from('orders').insert(...)` resolves to a RELATIVE specifier —
// which the attributable-receiver rule correctly treats as app code, and which therefore made the sink
// disappear entirely. One hop away it is a real dependency, and that chain is import-to-import, so it is
// evidence rather than inference. The negative cases below are the reason this is narrow: a relative
// receiver only becomes a dependency when the export actually TRACES to one.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-impclient-'));
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { express: '4', '@supabase/supabase-js': '2', pg: '8' },
  }));
  writeFileSync(join(dir, 'src', 'lib', 'db.ts'), `
    import { createClient } from "@supabase/supabase-js";
    export const db = createClient("u", "k");
  `);
  writeFileSync(join(dir, 'src', 'lib', 'pool.ts'), `
    import { Pool } from "pg";
    export const pool = new Pool();
  `);
  // App code whose export names collide with dangerous APIs and trace to NOTHING.
  writeFileSync(join(dir, 'src', 'lib', 'util.ts'), `
    export function exec(x: string) { return x.length }
    export function query(x: string) { return x }
    export function from(x: string) { return x }
  `);
  // A re-export chain: deliberately NOT followed (one hop only).
  writeFileSync(join(dir, 'src', 'lib', 'reexport.ts'), `export { db } from "./db";`);
  writeFileSync(join(dir, 'src', 'server.ts'), `
    import express from "express";
    import { db } from "./lib/db";
    import { pool } from "./lib/pool";
    import { db as renamed } from "./lib/db";
    import * as helper from "./lib/util";
    import { db as chained } from "./lib/reexport";
    const app = express();
    app.post("/orders", async (req, res) => { await db.from("orders").insert({ title: req.body.title }); res.end(); });
    app.post("/sql", async (req, res) => { await pool.query(req.body.sql); res.end(); });
    app.post("/renamed", async (req, res) => { await renamed.from("t").insert({ v: req.body.v }); res.end(); });
    app.post("/lookalike", (req, res) => { helper.exec(req.body.cmd); helper.query(req.body.sql); helper.from("t").insert({ v: req.body.v }); res.end(); });
    app.post("/chained", async (req, res) => { await chained.from("t").insert({ v: req.body.v }); res.end(); });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ep = async (route: string) => {
  const { map } = await buildInputMap(dir);
  return map!.endpoints.find((e) => e.route === route)!;
};

describe('a client imported from a local module', () => {
  it('resolves to the dependency it was created from', async () => {
    const e = await ep('/orders');
    const sink = e.sinks.find((s) => s.kind === 'db');
    expect(sink).toBeDefined();
    expect(sink!.package).toBe('@supabase/supabase-js');
    // Not `inferred`: the receiver itself traces there, through this file's import and that module's.
    expect(sink!.attribution).toBe('import');
    // The sink call is in THIS file, so it keeps local call-site evidence (no `file` override).
    expect(sink!.file).toBeUndefined();
  });

  it('lets a real candidate compile that was previously invisible', async () => {
    const e = await ep('/sql');
    const sink = e.sinks.find((s) => s.kind === 'db')!;
    expect(sink.package).toBe('pg');
    const flow = e.flows.find((f) => f.inputId === 'post:sql')!;
    expect(flow.confidence).toBe('exact-local');
    expect(flow.ruleGeneratable).toBe(true);
    expect(flow.candidateFamily).toBe('sql-injection');
  });

  it('follows a renamed import via its exported name', async () => {
    const e = await ep('/renamed');
    expect(e.sinks.map((s) => `${s.kind}/${s.package}`)).toEqual(['db/@supabase/supabase-js']);
  });

  it('does NOT resurrect lookalikes: an export that traces to nothing stays app code', async () => {
    const e = await ep('/lookalike');
    // `exec`, `query` and even `from(...).insert(...)` here are ordinary local functions.
    expect(e.sinks).toEqual([]);
    expect(e.flows.filter((f) => f.ruleGeneratable)).toEqual([]);
    // The inputs are still reported — the surface is real, the sink was not.
    expect(e.inputs.map((i) => i.name).sort()).toEqual(['cmd', 'sql', 'v']);
  });

  it('stops at one hop: a re-export chain is not followed (documented limitation)', async () => {
    const e = await ep('/chained');
    expect(e.sinks).toEqual([]);
  });
});

describe('the project boundary still holds', () => {
  it('does not resolve a client through a symlink that leaves the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ps-outside-'));
    writeFileSync(join(outside, 'secretdb.ts'), `
      import { createClient } from "@supabase/supabase-js";
      export const db = createClient("u", "k");
    `);
    const inside = mkdtempSync(join(tmpdir(), 'ps-inside-'));
    mkdirSync(join(inside, 'src'), { recursive: true });
    writeFileSync(join(inside, 'package.json'), JSON.stringify({ dependencies: { express: '4', '@supabase/supabase-js': '2' } }));
    symlinkSync(join(outside, 'secretdb.ts'), join(inside, 'src', 'linked.ts'));
    writeFileSync(join(inside, 'src', 'server.ts'), `
      import express from "express";
      import { db } from "./linked";
      const app = express();
      app.post("/x", async (req, res) => { await db.from("t").insert({ v: req.body.v }); res.end(); });
    `);
    const { map } = await buildInputMap(inside);
    const e = map!.endpoints.find((x) => x.route === '/x')!;
    expect(e.sinks).toEqual([]); // the resolver refuses to leave the project
    rmSync(inside, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

// Package provenance is NOT API provenance. `.query()` is a generic method name: an `@apollo/client`
// instance resolves to a genuine dependency while having nothing to do with SQL, and admitting that as a
// database sink compiled a precise SQL-injection candidate for a GraphQL call — a rule that would block
// legitimate traffic and mitigate nothing. This predates the imported-client hop (a same-file
// `new ApolloClient()` hit it too); the hop only made it easier to reach.
describe('a traced package must also establish the API', () => {
  let d: string;
  beforeAll(() => {
    d = mkdtempSync(join(tmpdir(), 'ps-api-'));
    mkdirSync(join(d, 'src', 'lib'), { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({
      dependencies: { express: '4', '@apollo/client': '3', pg: '8', 'drizzle-orm': '0.30' },
    }));
    writeFileSync(join(d, 'src', 'lib', 'gql.ts'), `
      import { ApolloClient } from "@apollo/client";
      export const client = new ApolloClient({ uri: "https://api.example.com" });
    `);
    writeFileSync(join(d, 'src', 'lib', 'pool.ts'), `
      import { Pool } from "pg";
      export const pool = new Pool();
    `);
    writeFileSync(join(d, 'src', 'lib', 'orm.ts'), `
      import { drizzle } from "drizzle-orm/node-postgres";
      export const orm = drizzle({});
    `);
    writeFileSync(join(d, 'src', 'server.ts'), `
      import express from "express";
      import { ApolloClient } from "@apollo/client";
      import { Pool } from "pg";
      import { client } from "./lib/gql";
      import { pool } from "./lib/pool";
      import { orm } from "./lib/orm";
      const app = express();
      const inline = new ApolloClient({ uri: "https://api.example.com" });
      app.post("/gql-imported", async (req, res) => { await client.query(req.body.sql); res.end(); });
      app.post("/gql-inline", async (req, res) => { await inline.query(req.body.sql); res.end(); });
      app.post("/pg", async (req, res) => { await pool.query(req.body.sql); res.end(); });
      app.post("/orm", async (req, res) => { await orm.execute(req.body.sql); res.end(); });
      // The direct \`pg\` import above is what makes this an INFERRED package rather than an untraceable
      // one: the file demonstrably talks to pg, but nothing traces \`res.locals.db\` to it.
      app.post("/untraced", async (req, res) => { await res.locals.db.query(req.body.sql); res.end(); });
    `);
  });
  afterAll(() => rmSync(d, { recursive: true, force: true }));

  const route = async (r: string) => {
    const { map } = await buildInputMap(d);
    return map!.endpoints.find((e) => e.route === r)!;
  };

  it.each(['/gql-imported', '/gql-inline'])('refuses a rule for a non-DB client at %s', async (r) => {
    const e = await route(r);
    const sink = e.sinks.find((s) => s.kind === 'db')!;
    expect(sink.package).toBe('@apollo/client');
    expect(sink.attribution).toBe('import');   // the package IS established…
    expect(sink.apiUnconfirmed).toBe(true);    // …but it does not establish a DB API
    expect(sink.provider).toBeUndefined();     // so it does not get to call itself SQL either
    const flow = e.flows.find((f) => f.sink.kind === 'db')!;
    expect(flow.confidence).toBe('exact-local'); // the data really does reach it
    expect(flow.ruleGeneratable).toBe(false);
    expect(flow.candidateFamily).toBeUndefined(); // and it must not advertise a class it cannot support
    expect(flow.ruleGeneratableReasons!.join(' ')).toMatch(/does not establish a db API/);
  });

  it('claims a provider only when the RECEIVER was traced, not just the package', async () => {
    // `res.locals.db.query(x)` in a file that imports pg: the package is inferred from the file, so the
    // sink must not assert `provider: 'sql'` about a receiver nobody traced. The flow was already refused
    // for the inferred attribution; this is about not overstating it in the inventory, where a human reads
    // it. No separate confidence field — `attribution` already carries the strength.
    const e = await route('/untraced');
    const sink = e.sinks.find((s) => s.kind === 'db')!;
    expect(sink.package).toBe('pg');          // the hint survives
    expect(sink.attribution).toBe('inferred');
    expect(sink.provider).toBeUndefined();    // …but the API claim does not
    expect(sink.apiUnconfirmed).toBeUndefined(); // and this is NOT the "wrong package" case
    expect(e.flows.every((f) => f.ruleGeneratable === false)).toBe(true);
  });

  it('keeps the sink in the inventory — a .query() on an unknown client is worth a human look', async () => {
    const e = await route('/gql-imported');
    expect(e.sinks).toHaveLength(1);
  });

  it.each([
    ['/pg', 'pg'],
    ['/orm', 'drizzle-orm'],
  ])('still generates for a real driver at %s', async (r, pkg) => {
    const e = await route(r);
    const sink = e.sinks.find((s) => s.kind === 'db')!;
    expect(sink.package).toBe(pkg);            // subpath imports resolve to the package
    expect(sink.apiUnconfirmed).toBeUndefined();
    expect(sink.provider).toBe('sql');
    const flow = e.flows.find((f) => f.sink.kind === 'db')!;
    expect(flow.ruleGeneratable).toBe(true);
    expect(flow.candidateFamily).toBe('sql-injection');
  });
});
