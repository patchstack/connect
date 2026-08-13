import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

// Making unmodelled code VISIBLE. An endpoint whose sink argument is a dynamic key or a spread cannot be
// rule-generated, and saying so — with the offending expression — is far more useful than showing no
// flow and letting an operator assume there is nothing there. This is the improvement queue.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-lim-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@supabase/supabase-js': '2', express: '4' } }));
  writeFileSync(join(dir, 'src', 'unmodelled.ts'), `
    import { createClient } from "@supabase/supabase-js";
    const db = createClient("u", "k");
    export async function POST(req) {
      const body = await req.json();
      const field = body.which;
      await db.from("t").insert({ v: body[field] });
      await db.from("t2").insert({ ...body });
      return new Response("ok");
    }
  `);
  // A clean endpoint must NOT acquire limitations.
  writeFileSync(join(dir, 'src', 'clean.ts'), `
    import fs from "node:fs";
    import express from "express";
    const app = express();
    app.post("/read", (req, res) => { res.end(fs.readFileSync(req.body.file)); });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ep = async (file: string) => {
  const { map } = await buildInputMap(dir);
  return { map: map!, endpoint: map!.endpoints.find((e) => e.file.endsWith(file))! };
};

describe('endpoint limitations', () => {
  it('reports a dynamic computed key with the offending expression and line', async () => {
    const { endpoint } = await ep('unmodelled.ts');
    const dyn = endpoint.limitations?.find((l) => l.kind === 'dynamic-key');
    expect(dyn).toBeDefined();
    expect(dyn!.detail).toContain('body[field]');
    expect(typeof dyn!.line).toBe('number');
  });

  it('reports a spread that hides which field reaches the sink', async () => {
    const { endpoint } = await ep('unmodelled.ts');
    const spread = endpoint.limitations?.find((l) => l.kind === 'spread-into-sink');
    expect(spread).toBeDefined();
    expect(spread!.detail).toContain('...body');
  });

  it('names the specific cause in the flow reasons, not just "heuristic"', async () => {
    const { endpoint } = await ep('unmodelled.ts');
    const reasons = endpoint.flows.flatMap((f) => f.ruleGeneratableReasons ?? []).join(' | ');
    expect(reasons).toMatch(/dynamic computed key reaches this sink/);
    expect(reasons).toMatch(/spread reaches this sink/);
    // None of these may be rule-generatable.
    expect(endpoint.flows.every((f) => f.ruleGeneratable === false)).toBe(true);
  });

  it('leaves a cleanly-analysable endpoint without limitations', async () => {
    const { endpoint } = await ep('clean.ts');
    expect(endpoint.limitations).toBeUndefined();
    expect(endpoint.flows.some((f) => f.ruleGeneratable)).toBe(true);
  });
});

describe('schema honesty', () => {
  it('reports filesPreFiltered explicitly rather than making consumers subtract', async () => {
    const { map } = await ep('clean.ts');
    const c = map.coverage;
    expect(typeof c.filesPreFiltered).toBe('number');
    // The three buckets must account for everything discovered — otherwise "6 of 66 parsed" reads as
    // "91% unanalysed" when most of a project is simply client code with no entry point.
    expect(c.filesParsed + c.filesPreFiltered + c.filesSkipped).toBe(c.filesDiscovered);
  });

  it('gives every sink a stable id so a flow copy can be correlated to the inventory', async () => {
    const { map } = await ep('unmodelled.ts');
    for (const endpoint of map.endpoints) {
      const ids = endpoint.sinks.map((s) => s.id);
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length); // distinct per sink
      for (const f of endpoint.flows) {
        // The embedded copy carries the same identity as its inventory entry.
        expect(ids).toContain(f.sink.id);
      }
    }
  });

  it('is deterministic: the same source yields the same sink ids', async () => {
    const a = await ep('unmodelled.ts');
    const b = await ep('unmodelled.ts');
    expect(a.endpoint.sinks.map((s) => s.id)).toEqual(b.endpoint.sinks.map((s) => s.id));
  });
});
