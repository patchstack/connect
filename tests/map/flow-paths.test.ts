import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

// `precise` is the signal a rule-generator would pin a parameter on, so it must identify the RIGHT
// parameter. Two ways it previously could not:
//   1. paths were reduced to their last segment, so `billing.email` and `shipping.email` collided;
//   2. evidence was gathered from the enclosing statement, so a sibling expression could lend it.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-paths-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@tanstack/react-start': '1' } }));

  // Nested paths that share a leaf name; only shipping.email actually reaches the sink.
  writeFileSync(join(dir, 'src', 'nested.ts'), `
    import { createServerFn } from "@tanstack/react-start";
    import { z } from "zod";
    import { createClient } from "@supabase/supabase-js";
    const db = createClient("u","k");
    export const send = createServerFn({ method: "POST" })
      .inputValidator((i) => z.object({
        billing: z.object({ email: z.string() }),
        shipping: z.object({ email: z.string() }),
      }).parse(i))
      .handler(async ({ data }) => {
        await db.from("mail").insert({ to: data.shipping.email });
      });
  `);

  // A sibling expression in the same statement reads data.title; the insert must not inherit it.
  writeFileSync(join(dir, 'src', 'sibling.ts'), `
    import { createClient } from "@supabase/supabase-js";
    const db = createClient("u","k");
    function audit(x) { return x; }
    export async function PUT(req) {
      const data = await req.json();
      await Promise.all([ audit(data.title), db.from("items").insert({ title: "system" }) ]);
      return new Response("ok");
    }
  `);

  // A fluent chain IS one operation: both the values object and the .eq filter feed the update.
  writeFileSync(join(dir, 'src', 'chain.ts'), `
    import { createClient } from "@supabase/supabase-js";
    const db = createClient("u","k");
    export async function PATCH(req) {
      const data = await req.json();
      await db.from("items").update({ note: data.note }).eq("id", data.id);
      return new Response("ok");
    }
  `);

  // Arrays: tags[].label must match a read of tags[0].label.
  writeFileSync(join(dir, 'src', 'arrays.ts'), `
    import { createServerFn } from "@tanstack/react-start";
    import { z } from "zod";
    import { createClient } from "@supabase/supabase-js";
    const db = createClient("u","k");
    export const tag = createServerFn({ method: "POST" })
      .inputValidator((i) => z.object({ tags: z.array(z.object({ label: z.string() })) }).parse(i))
      .handler(async ({ data }) => { await db.from("t").insert({ l: data.tags[0].label }); });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const flowsOf = async (file: string) => {
  const { map } = await buildInputMap(dir);
  return map!.endpoints.find((e) => e.file.endsWith(file))!;
};

describe('flow paths and sink ownership', () => {
  it('distinguishes nested paths that share a leaf name', async () => {
    const ep = await flowsOf('nested.ts');
    const precise = ep.flows.filter((f) => f.confidence === 'precise').map((f) => f.input).sort();
    // shipping.email is read (and `shipping` is its ancestor, so it covers the flow).
    expect(precise).toEqual(['shipping', 'shipping.email']);
    // The collision case: billing.* must NOT be precise.
    expect(precise).not.toContain('billing.email');
    expect(precise).not.toContain('billing');
  });

  it('does not let a sibling expression in the same statement lend evidence', async () => {
    const ep = await flowsOf('sibling.ts');
    expect(ep.flows.filter((f) => f.confidence === 'precise')).toEqual([]);
  });

  it('treats a fluent chain as one operation', async () => {
    const ep = await flowsOf('chain.ts');
    const precise = ep.flows.filter((f) => f.confidence === 'precise').map((f) => f.input).sort();
    expect(precise).toEqual(['id', 'note']); // the values object AND the .eq filter
  });

  it('normalizes array indices so tags[].label matches a read of tags[0].label', async () => {
    const ep = await flowsOf('arrays.ts');
    expect(ep.flows.some((f) => f.input === 'tags[].label' && f.confidence === 'precise')).toBe(true);
  });

  it('keeps taint through a validator (validation is not sanitization) and records sink spans', async () => {
    const ep = await flowsOf('nested.ts');
    expect(ep.flows.some((f) => f.confidence === 'precise')).toBe(true); // would be none if validation cleaned
    const sink = ep.sinks[0]!;
    expect(typeof sink.start).toBe('number');
    expect(typeof sink.end).toBe('number');
    expect(sink.end!).toBeGreaterThan(sink.start!);
  });
});
