import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { isProvenFlow } from '../../src/map/coordinates.js';

// `precise` is a claim a consumer may PIN A RULE ON, so it must be evidence-backed: the input has to be
// genuinely READ into the sink. A property key that merely shares the input's name, with an unrelated
// tainted value elsewhere in the same call, is NOT evidence.
let dir: string, outside: string;
beforeAll(() => {
  outside = mkdtempSync(join(tmpdir(), 'ps-other-repo-'));
  writeFileSync(join(outside, 'db.ts'), `
    import { createClient } from "@supabase/supabase-js";
    const c = createClient("u", "k");
    export function shouldNotBeSeen(x) { return c.from("secrets").delete().eq("id", x); }
  `);

  dir = mkdtempSync(join(tmpdir(), 'ps-flow-'));
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));

  // The counterexample: `title` appears only as a KEY; the tainted `req` appears in a DIFFERENT value.
  writeFileSync(join(dir, 'src', 'keyonly.ts'), `
    import { createClient } from "@supabase/supabase-js";
    const db = createClient("u", "k");
    export async function POST(req) {
      const { title } = await req.json();
      await db.from("items").insert({ title: "system", owner: req.user.id });
      return new Response("ok");
    }
  `);

  // A genuine read of the input into the sink.
  writeFileSync(join(dir, 'src', 'real.ts'), `
    import { createClient } from "@supabase/supabase-js";
    const db = createClient("u", "k");
    export async function PUT(req) {
      const { title } = await req.json();
      await db.from("items").insert({ title });
      return new Response("ok");
    }
  `);

  // Aliased import of a helper that owns the sink.
  writeFileSync(join(dir, 'src', 'lib', 'db.ts'), `
    import { createClient } from "@supabase/supabase-js";
    const c = createClient("u", "k");
    export function saveOrder(o) { return c.from("orders").insert(o); }
  `);
  writeFileSync(join(dir, 'src', 'alias.ts'), `
    import { saveOrder as write } from "./lib/db";
    export async function PATCH(req) {
      const body = await req.json();
      return write({ note: body.note });
    }
  `);

  // An import that escapes the project directory.
  writeFileSync(join(dir, 'src', 'escape.ts'), `
    import { shouldNotBeSeen } from "${join(outside, 'db').replace(/\\/g, '/')}";
    export async function DELETE(req) { return shouldNotBeSeen(req.query.id); }
  `);
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

describe('flow precision', () => {
  it('does NOT claim precise when the input name is only a property key', async () => {
    const { map } = await buildInputMap(dir);
    const ep = map!.endpoints.find((e) => e.file.endsWith('keyonly.ts'))!;
    const titleFlows = ep.flows.filter((f) => f.input === 'title');
    expect(titleFlows.length).toBeGreaterThan(0);
    expect(titleFlows.every((f) => f.confidence === 'heuristic')).toBe(true);
  });

  it('does claim precise for a real read (shorthand property)', async () => {
    const { map } = await buildInputMap(dir);
    const ep = map!.endpoints.find((e) => e.file.endsWith('real.ts'))!;
    expect(ep.flows.some((f) => f.input === 'title' && isProvenFlow(f.confidence))).toBe(true);
  });

  it('resolves an ALIASED imported helper to its exported name', async () => {
    const { map } = await buildInputMap(dir);
    const ep = map!.endpoints.find((e) => e.file.endsWith('alias.ts'))!;
    expect(ep.sinks).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'db', table: 'orders', op: 'insert' })]),
    );
  });

  it('labels an imported sink with ITS OWN file, and never claims a proven flow for it', async () => {
    const { map } = await buildInputMap(dir);
    const ep = map!.endpoints.find((e) => e.file.endsWith('alias.ts'))!;
    const imported = ep.sinks.find((s) => s.table === 'orders')!;
    expect(imported.file).toBe(join('src', 'lib', 'db.ts'));
    // `imported`, not the generic `heuristic`: the call site is in another module, so no argument-level
    // evidence can exist here. Naming the reason is the difference between "no link" and "cannot see".
    const flows = ep.flows.filter((f) => f.sink.table === 'orders');
    expect(flows.length).toBeGreaterThan(0);
    expect(flows.every((f) => f.confidence === 'imported')).toBe(true);
    expect(flows.every((f) => !isProvenFlow(f.confidence))).toBe(true);
  });

  it('refuses to follow an import outside the project directory', async () => {
    const { map } = await buildInputMap(dir);
    const ep = map!.endpoints.find((e) => e.file.endsWith('escape.ts'))!;
    expect(ep.sinks.some((s) => s.table === 'secrets')).toBe(false);
  });
});
