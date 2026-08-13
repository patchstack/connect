import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import type { SiteInputMap, Endpoint } from '../../src/map/types.js';

// Regression suite for the strict-review hardening: destructured / request.json() inputs, pre-filter ↔
// recognizer parity, chained + object route registration, bindings-gated sinks (local objects are not
// dependency sinks), validator gating + nested fields + formats, node: builtin normalization, source
// positions, and the honesty markers (inputsResolved, dynamic coverage notes).

let dir: string;
let map: SiteInputMap;
const ep = (pred: (e: Endpoint) => boolean): Endpoint => {
  const found = map.endpoints.find(pred);
  expect(found).toBeDefined();
  return found!;
};
const inputNames = (e: Endpoint) => e.inputs.map((i) => i.name).sort();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ps-map-strict-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { express: '4', fastify: '5', '@tanstack/react-start': '1' },
  }));

  // Destructured req.body, destructured handler param, head/use registrations, chained .route().get().
  writeFileSync(join(dir, 'src', 'express.ts'), `
    import express from "express";
    import fs from "fs";
    import { exec } from "node:child_process";
    const app = express();
    app.post("/api/items", (req, res) => {
      const { title, qty } = req.body;
      fs.writeFileSync("/tmp/x", title + qty);
      res.end();
    });
    app.post("/api/other", ({ body }, res) => {
      const cache = { params: { zzz: 1 } };
      console.log(cache.params.zzz);
      res.end(String(body.note));
    });
    app.head("/health", (req, res) => res.end());
    app.use("/legacy", (req, res) => { run(req.query.cmd); res.end(); });
    function run(cmd) { exec("legacy " + cmd); }
    const r = express.Router();
    r.route("/chained").get((req, res) => { fs.readFile(req.query.f, () => res.end()); });
  `);

  // Fastify object-form registration with a method array.
  writeFileSync(join(dir, 'src', 'fastify.ts'), `
    import Fastify from "fastify";
    const app = Fastify();
    app.route({
      method: ["POST", "PUT"],
      url: "/upload",
      handler: async (req, reply) => {
        const { filename } = req.body;
        reply.send(filename);
      },
    });
  `);

  // fetch-style Request body reads + a non-validator ".object(" decoy.
  writeFileSync(join(dir, 'src', 'next-route.ts'), `
    import { createClient } from "@supabase/supabase-js";
    const supabase = createClient("u", "k");
    const t = { object: (x) => x };
    export async function POST(request) {
      const shape = t.object({ decoy: 1 });
      const body = await request.json();
      const { extra } = await request.json();
      await supabase.from("orders").insert({ note: body.note, qty: body.qty, extra });
      return new Response(String(shape));
    }
  `);

  // Local objects/functions must not read as dependency sinks.
  writeFileSync(join(dir, 'src', 'sinks-gate.ts'), `
    import express from "express";
    const app = express();
    class WorkQueue { open() { return this; } query(s) { return s; } execute() { return 1; } }
    function request(x) { return x; }
    app.post("/probe", (req, res) => {
      const q = new WorkQueue();
      q.open(); q.query("a"); q.execute(); request("h");
      res.end();
    });
  `);

  // Zod: nested objects/arrays, formats, regex, negative bounds; plus an opaque validator.
  writeFileSync(join(dir, 'src', 'zod.functions.ts'), `
    import { createServerFn } from "@tanstack/react-start";
    import { z } from "zod";
    export const saveProfile = createServerFn({ method: "POST" })
      .inputValidator((i) => z.object({
        email: z.string().email(),
        slug: z.string().regex(/^[a-z0-9-]+$/),
        offset: z.number().min(-10).max(50),
        address: z.object({ city: z.string().min(1) }),
        tags: z.array(z.object({ label: z.string() })),
      }).parse(i))
      .handler(async ({ data }) => data);
    export const opaque = createServerFn({ method: "POST" })
      .inputValidator((i) => checkSomehow(i))
      .handler(async ({ data }) => data);
  `);

  // Transitive binding: conn ← pool.promise() ← createPool ← mysql2.
  writeFileSync(join(dir, 'src', 'transitive.ts'), `
    import express from "express";
    import { createPool } from "mysql2";
    const app = express();
    const pool = createPool({});
    const conn = pool.promise();
    app.post("/sql", (req, res) => { conn.query(req.body.sql); res.end(); });
  `);

  // A route file reachable only through a symlinked directory.
  mkdirSync(join(dir, 'linked-src'), { recursive: true });
  writeFileSync(join(dir, 'linked-src', 'ext.ts'), `
    import express from "express";
    const app = express();
    app.post("/linked", (req, res) => res.end(req.body.x));
  `);
  symlinkSync(join(dir, 'linked-src'), join(dir, 'src', 'ext'));

  const res = await buildInputMap(dir);
  expect(res.error).toBeUndefined();
  map = res.map!;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('inputs: destructuring and fetch-style bodies', () => {
  it('extracts fields destructured from req.body', () => {
    const e = ep((x) => x.route === '/api/items');
    expect(inputNames(e)).toEqual(['qty', 'title']);
    expect(e.sinks).toEqual([
      expect.objectContaining({ kind: 'fs', package: 'node:fs', op: 'writeFileSync' }),
    ]);
  });

  it('follows a destructured handler param without matching unrelated objects', () => {
    const e = ep((x) => x.route === '/api/other');
    expect(inputNames(e)).toEqual(['note']); // body.note yes, cache.params.zzz no
  });

  it('traces `await request.json()` bodies through variables and destructuring', () => {
    const e = ep((x) => x.name === 'POST' && x.entryKind === 'route-handler');
    expect(inputNames(e)).toEqual(['extra', 'note', 'qty']); // and never the t.object decoy
    expect(e.sinks).toEqual([
      expect.objectContaining({ kind: 'db', package: '@supabase/supabase-js', table: 'orders', op: 'insert' }),
    ]);
  });
});

describe('entry points: pre-filter parity and registration idioms', () => {
  it('sees files that only register .head()/.use() routes', () => {
    expect(ep((x) => x.route === '/health').method).toBe('HEAD');
    const legacy = ep((x) => x.route === '/legacy');
    expect(legacy.method).toBeUndefined(); // `use` is not an HTTP method
    expect(inputNames(legacy)).toEqual(['cmd']);
    expect(legacy.sinks).toEqual([
      expect.objectContaining({ kind: 'exec', package: 'node:child_process', op: 'exec' }), // via run()
    ]);
  });

  it('recovers the path from router.route("/x").get(handler) chains', () => {
    const e = ep((x) => x.route === '/chained');
    expect(e.method).toBe('GET');
    expect(inputNames(e)).toEqual(['f']);
    expect(e.sinks).toEqual([expect.objectContaining({ kind: 'fs', package: 'node:fs', op: 'readFile' })]);
  });

  it('reads Fastify route objects, one endpoint per method', () => {
    const uploads = map.endpoints.filter((x) => x.route === '/upload');
    expect(uploads.map((u) => u.method).sort()).toEqual(['POST', 'PUT']);
    for (const u of uploads) expect(inputNames(u)).toEqual(['filename']);
  });

  it('follows symlinked source directories', () => {
    expect(inputNames(ep((x) => x.route === '/linked'))).toEqual(['x']);
  });
});

describe('sinks: bindings gating and package attribution', () => {
  it('does not report calls on local objects/functions as dependency sinks', () => {
    expect(ep((x) => x.route === '/probe').sinks).toEqual([]);
  });

  it('resolves packages transitively through derived bindings', () => {
    const e = ep((x) => x.route === '/sql');
    expect(inputNames(e)).toEqual(['sql']);
    expect(e.sinks).toEqual([expect.objectContaining({ kind: 'db', package: 'mysql2', op: 'query' })]);
  });

  it('records source positions on endpoints and sinks', () => {
    const e = ep((x) => x.route === '/api/items');
    expect(e.line).toBeGreaterThan(0);
    expect(e.sinks[0].line).toBeGreaterThan(0);
  });
});

describe('validator schemas: gating, nesting, formats', () => {
  it('extracts nested fields as dotted paths with constraints', () => {
    const e = ep((x) => x.name === 'saveProfile');
    const byName = Object.fromEntries(e.inputs.map((i) => [i.name, i]));
    expect(byName['email']).toMatchObject({ name: 'email', type: 'string', format: 'email' });
    expect(byName['slug']).toMatchObject({ type: 'string', pattern: '/^[a-z0-9-]+$/' });
    expect(byName['offset']).toMatchObject({ name: 'offset', type: 'number', min: -10, max: 50 });
    expect(byName['address']).toMatchObject({ type: 'object' });
    expect(byName['address.city']).toMatchObject({ name: 'address.city', type: 'string', min: 1 });
    expect(byName['tags']).toMatchObject({ type: 'array' });
    expect(byName['tags[].label']).toMatchObject({ type: 'string' });
    expect(e.inputsResolved).toBeUndefined();
  });

  it('marks endpoints whose validator could not be parsed, and says so in coverage', () => {
    const e = ep((x) => x.name === 'opaque');
    expect(e.inputs).toEqual([]);
    expect(e.inputsResolved).toBe(false);
    expect(map.coverage.notes.join(' ')).toMatch(/UNKNOWN, not empty/);
  });
});
