import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../src/map/index.js';

// The agnostic extractor across three stacks in one fixture app: a TanStack server fn (zod inputs +
// supabase sink, incl. a helper-indirected select), an Express route (req.body access + fs/exec
// sinks), and a Next-style route handler (supabase sink).

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-map-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@tanstack/react-start': '1', express: '4' } }));

  writeFileSync(join(dir, 'src', 'tasks.functions.ts'), `
    import { createServerFn } from "@tanstack/react-start";
    import { z } from "zod";
    import { createClient } from "@supabase/supabase-js";
    const supabase = createClient(process.env.URL, process.env.KEY);
    function listTasks() {
      return supabase.from("tasks").select("id, title").order("created_at");
    }
    export const getTasks = createServerFn({ method: "GET" }).handler(async () => listTasks());
    export const createTask = createServerFn({ method: "POST" })
      .inputValidator((input) => z.object({ title: z.string().trim().min(1).max(200) }).parse(input))
      .handler(async ({ data }) => { supabase.from("tasks").insert({ title: data.title }); return listTasks(); });
  `);

  writeFileSync(join(dir, 'src', 'server.ts'), `
    import express from "express";
    import { exec } from "node:child_process";
    import fs from "node:fs";
    const app = express();
    app.post("/api/convert", (req, res) => {
      fs.writeFileSync(req.body.path, req.body.data);
      exec("convert " + req.query.fmt);
      res.end();
    });
  `);

  writeFileSync(join(dir, 'src', 'route.ts'), `
    import { createClient } from "@supabase/supabase-js";
    const supabase = createClient(process.env.URL, process.env.KEY);
    export async function POST(request) {
      const body = await request.json();
      return supabase.from("orders").insert({ note: body.note });
    }
  `);

  writeFileSync(join(dir, 'src', 'actions.ts'), `
    'use server';
    import { exec } from "node:child_process";
    export async function runReport(input) {
      exec("report " + input.name);
    }
  `);

  // ROOT-level entrypoint (not under src/) — common for server.ts / app.ts / worker entrypoints.
  writeFileSync(join(dir, 'root-server.cjs'), `
    const express = require("express");
    const fs = require("node:fs");
    const app = express();
    app.post("/root/upload", (req, res) => {
      fs.writeFileSync("/tmp/x", req.body.blob);
      res.end();
    });
  `);

  // A handler with a DECLARED-BUT-UNCALLED local helper that shells out: its exec must NOT be
  // attributed to the endpoint, while the helper it DOES call must be.
  writeFileSync(join(dir, 'src', 'fp.ts'), `
    import { exec } from "node:child_process";
    import fs from "node:fs";
    export async function PUT(req) {
      function neverCalled() { exec("rm -rf /"); }
      const used = () => { fs.readFileSync("/etc/hosts"); };
      used();
      return new Response("ok");
    }
  `);

  // A Next App Router file-based route (dynamic segment) — its URL path lives in the LOCATION.
  mkdirSync(join(dir, 'app', 'api', 'orders', '[id]'), { recursive: true });
  writeFileSync(join(dir, 'app', 'api', 'orders', '[id]', 'route.ts'), `
    import { createClient } from "@supabase/supabase-js";
    const supabase = createClient(process.env.URL, process.env.KEY);
    export async function PATCH(request) {
      const body = await request.json();
      return supabase.from("orders").update({ note: body.note }).eq("id", body.id);
    }
  `);

  // A local factory returning an imported client — the client must still resolve to its package.
  writeFileSync(join(dir, 'src', 'factory.ts'), `
    import { createClient } from "@supabase/supabase-js";
    function getClient() { return createClient(process.env.URL, process.env.KEY); }
    export async function DELETE(req) {
      const db = getClient();
      return db.from("audit").delete().eq("id", req.query.id);
    }
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('agnostic input-flow extractor', () => {
  it('extracts entry points across TanStack / Express / Next shapes', async () => {
    const { map, error } = await buildInputMap(dir);
    expect(error).toBeUndefined();
    expect(map).not.toBeNull();
    const byName = Object.fromEntries(map!.endpoints.map((e) => [e.name, e]));

    // TanStack server fn: zod input + direct + helper-indirected sinks, each tagged with the package.
    expect(byName.createTask).toMatchObject({ entryKind: 'server-fn', method: 'POST' });
    expect(byName.createTask.inputs).toEqual([
      // Includes the runtime coordinate: a server fn's validated args are delivered as the JSON body,
      // so the engine addresses them with `post.<path>`.
      expect.objectContaining({ name: 'title', type: 'string', min: 1, max: 200, source: 'server-fn-data', runtimeParameter: 'post.title' }),
    ]);
    expect(byName.createTask.sinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'db', provider: 'sql', package: '@supabase/supabase-js', table: 'tasks', op: 'insert' }),
        expect.objectContaining({ kind: 'db', provider: 'sql', package: '@supabase/supabase-js', table: 'tasks', op: 'select' }), // via listTasks()
      ]),
    );
    expect(byName.getTasks.inputs).toEqual([]);
    expect(byName.getTasks.sinks).toEqual([
      expect.objectContaining({ kind: 'db', provider: 'sql', package: '@supabase/supabase-js', table: 'tasks', op: 'select' }),
    ]);

    // Express route registration: path + method + req.body/query inputs + fs/exec sinks with node: packages.
    const convert = map!.endpoints.find((e) => e.route === '/api/convert')!;
    expect(convert.entryKind).toBe('route-registration');
    expect(convert.method).toBe('POST');
    expect(convert.inputs.map((i) => i.name).sort()).toEqual(['data', 'fmt', 'path']);
    expect(convert.sinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'fs', package: 'node:fs', op: 'writeFileSync' }),
        expect.objectContaining({ kind: 'exec', package: 'node:child_process', op: 'exec' }),
      ]),
    );

    // Next-style route handler: method from the export name, supabase sink with package.
    expect(byName.POST).toMatchObject({ entryKind: 'route-handler', method: 'POST' });
    expect(byName.POST.sinks).toEqual([
      expect.objectContaining({ kind: 'db', provider: 'sql', package: '@supabase/supabase-js', table: 'orders', op: 'insert' }),
    ]);
    expect(byName.POST.inputs.map((i) => i.name)).toEqual(['note']); // via `const body = await request.json()`

    // Next `'use server'` action: recognized as an entry point, exec sink tagged with its package.
    expect(byName.runReport).toMatchObject({ entryKind: 'server-action' });
    expect(byName.runReport.sinks).toEqual([
      expect.objectContaining({ kind: 'exec', package: 'node:child_process', op: 'exec' }),
    ]);
  });

  it('records honest coverage notes, counters and a framework label', async () => {
    const { map } = await buildInputMap(dir);
    expect(map!.framework).toBe('tanstack-start');
    const notes = map!.coverage.notes.join(' ');
    expect(notes).toMatch(/best-effort/i);
    // Must state that inputs/sinks are inventories and only `flows` asserts reachability.
    expect(notes).toMatch(/INVENTOR/i);
    expect(notes).toMatch(/flows/i);
    expect(map!.coverage.filesDiscovered).toBeGreaterThan(0);
    expect(map!.coverage.filesParsed).toBeGreaterThan(0);
    expect(map!.coverage.filesParsed).toBeLessThanOrEqual(map!.coverage.filesDiscovered);
  });

  it('links input → sink flows with evidence, and only claims "precise" when the data reaches it', async () => {
    const { map } = await buildInputMap(dir);
    const createTask = map!.endpoints.find((e) => e.name === 'createTask')!;
    const precise = createTask.flows.filter((f) => f.confidence === 'precise');
    // `title` is passed into the insert → proven.
    expect(precise).toEqual([
      expect.objectContaining({ input: 'title', confidence: 'precise', sink: expect.objectContaining({ op: 'insert' }) }),
    ]);
    // The helper-reached select does NOT receive the input → heuristic, never precise.
    expect(createTask.flows.some((f) => f.sink.op === 'select' && f.confidence === 'heuristic')).toBe(true);
    expect(precise.every((f) => typeof f.line === 'number')).toBe(true); // evidence location
  });

  it('scans root-level entrypoints and .cjs files, not just src/', async () => {
    const { map } = await buildInputMap(dir);
    const rootEp = map!.endpoints.find((e) => e.route === '/root/upload');
    expect(rootEp).toBeDefined();
    expect(rootEp!.file).toBe('root-server.cjs');
    expect(rootEp!.sinks).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'fs', package: 'node:fs', op: 'writeFileSync' })]),
    );
  });

  it('does not attribute sinks from a declared-but-uncalled local helper', async () => {
    const { map } = await buildInputMap(dir);
    const put = map!.endpoints.find((e) => e.name === 'PUT' && e.file.endsWith('fp.ts'))!;
    expect(put.sinks.some((s) => s.kind === 'exec')).toBe(false); // neverCalled() must not count
    expect(put.sinks.some((s) => s.kind === 'fs' && s.op === 'readFileSync')).toBe(true); // used() does
  });

  it('derives the URL path of a file-based route handler (so rules can be route-scoped)', async () => {
    const { map } = await buildInputMap(dir);
    const patch = map!.endpoints.find((e) => e.name === 'PATCH')!;
    // Full coordinates for pinning: route + method + inputs — the route came from the file location.
    expect(patch.route).toBe('/api/orders/:id');
    expect(patch.routeDynamic).toBe(true); // a PATTERN, so when.path needs a glob/regex
    expect(patch.method).toBe('PATCH');
    expect(patch.inputs.map((i) => i.name).sort()).toEqual(['id', 'note']);
    expect(patch.flows.some((f) => f.confidence === 'precise' && f.sink.op === 'update')).toBe(true);
  });

  it('resolves a client built by a local factory back to its package', async () => {
    const { map } = await buildInputMap(dir);
    const del = map!.endpoints.find((e) => e.name === 'DELETE')!;
    expect(del.sinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'db', package: '@supabase/supabase-js', table: 'audit', op: 'delete' }),
      ]),
    );
  });
});
