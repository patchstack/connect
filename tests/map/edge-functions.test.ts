import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

// Platform function runtimes (Supabase Edge Functions, Base44 backend functions, Deno workers) have no
// route file and no framework router: one handler per module, invoked by the function's NAME. Without a
// recognizer these projects map to nothing at all.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-edgefn-'));
  mkdirSync(join(dir, 'supabase', 'functions', 'charge'), { recursive: true });
  mkdirSync(join(dir, 'functions'), { recursive: true });

  // Supabase Edge Function: Deno.serve + destructured request read + a db sink.
  writeFileSync(join(dir, 'supabase', 'functions', 'charge', 'index.ts'), `
    import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
    const admin = createClient(Deno.env.get("URL"), Deno.env.get("KEY"));
    Deno.serve(async (req) => {
      const { orderId, amount } = await req.json();
      await admin.from("charges").insert({ orderId, amount });
      return new Response("ok");
    });
  `);

  // Generic Deno function dir (Base44 shape): bare serve() import + an outbound call.
  writeFileSync(join(dir, 'functions', 'notify.ts'), `
    import { serve } from "https://deno.land/std/http/server.ts";
    serve(async (req) => {
      const { hook } = await req.json();
      await fetch(hook, { method: "POST" });
      return new Response("sent");
    });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('platform function entry points', () => {
  it('recognizes a Supabase Edge Function, its route, inputs and sink', async () => {
    const { map } = await buildInputMap(dir);
    expect(map!.framework).toBe('supabase-functions');
    const charge = map!.endpoints.find((e) => e.name === 'charge');
    expect(charge, 'Deno.serve handler should be an entry point').toBeDefined();
    expect(charge!.entryKind).toBe('edge-function');
    expect(charge!.route).toBe('/charge'); // how the platform invokes it
    expect(charge!.inputs.map((i) => i.name).sort()).toEqual(['amount', 'orderId']);
    expect(charge!.sinks).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'db', table: 'charges', op: 'insert' })]),
    );
    // The insert receives the request data → a proven flow, so a rule can pin the parameter.
    expect(charge!.flows.some((f) => f.confidence === 'precise' && f.input === 'orderId')).toBe(true);
  });

  it('recognizes a bare serve() function and its outbound (SSRF-relevant) sink', async () => {
    const { map } = await buildInputMap(dir);
    const notify = map!.endpoints.find((e) => e.name === 'notify')!;
    expect(notify.entryKind).toBe('edge-function');
    expect(notify.route).toBe('/notify');
    expect(notify.inputs.map((i) => i.name)).toEqual(['hook']);
    expect(notify.sinks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'http' })]));
    // hook -> fetch is the classic SSRF shape; it must be a PROVEN flow, not a co-occurrence.
    expect(notify.flows.some((f) => f.input === 'hook' && f.sink.kind === 'http' && f.confidence === 'precise')).toBe(true);
  });
});
