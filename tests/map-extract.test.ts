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
    export async function POST(request) {
      const body = await request.json();
      return supabase.from("orders").insert({ note: body.note });
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

    // TanStack server fn: zod input + direct + helper-indirected sinks.
    expect(byName.createTask).toMatchObject({ entryKind: 'server-fn', method: 'POST' });
    expect(byName.createTask.inputs).toEqual([{ name: 'title', type: 'string', min: 1, max: 200 }]);
    expect(byName.createTask.sinks).toEqual(
      expect.arrayContaining([
        { kind: 'db', provider: 'sql', table: 'tasks', op: 'insert' },
        { kind: 'db', provider: 'sql', table: 'tasks', op: 'select' }, // via listTasks() one-level dataflow
      ]),
    );
    // getTasks has no input; sink reached only through the helper.
    expect(byName.getTasks.inputs).toEqual([]);
    expect(byName.getTasks.sinks).toEqual([{ kind: 'db', provider: 'sql', table: 'tasks', op: 'select' }]);

    // Express route registration: path + method + req.body/query inputs + fs/exec sinks.
    const convert = map!.endpoints.find((e) => e.route === '/api/convert')!;
    expect(convert.entryKind).toBe('route-registration');
    expect(convert.method).toBe('POST');
    expect(convert.inputs.map((i) => i.name).sort()).toEqual(['data', 'fmt', 'path']);
    expect(convert.sinks).toEqual(
      expect.arrayContaining([
        { kind: 'fs', op: 'writeFileSync' },
        { kind: 'exec', op: 'exec' },
      ]),
    );

    // Next-style route handler: method from the export name, supabase sink.
    expect(byName.POST).toMatchObject({ entryKind: 'route-handler', method: 'POST' });
    expect(byName.POST.sinks).toEqual([{ kind: 'db', provider: 'sql', table: 'orders', op: 'insert' }]);
  });

  it('records honest coverage notes and a framework label', async () => {
    const { map } = await buildInputMap(dir);
    expect(map!.framework).toBe('tanstack-start');
    expect(map!.coverage.notes.join(' ')).toMatch(/best-effort/i);
  });
});
