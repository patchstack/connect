import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import type { SiteInputMap } from '../../src/map/types.js';

// GOLDEN CORPUS. Unit fixtures prove a mechanism; this measures BEHAVIOUR across the stacks AI builders
// actually generate, and enforces the metric that governs whether auto-generated rules are safe:
//
//     an auto-generated parameter-pinned rule must target the wrong input at a rate of ZERO.
//
// Each case declares the candidates it expects (family + the exact runtime parameter) and the flows that
// must NOT become candidates. Two failure modes are then measured separately:
//   - WRONG-INPUT: a candidate exists that nobody declared → the rule would pin the wrong parameter.
//     This must be 0. It is the metric.
//   - MISSED: a declared candidate is absent → recall gap. Reported, and asserted per-case so a
//     regression is loud, but it is a lesser sin than a wrong pin.
// Every production false positive we ever find should become a permanent case here.

interface Case {
  name: string;
  pkg: Record<string, unknown>;
  files: Record<string, string>;
  /** `family @ runtimeParameter` for every flow that SHOULD compile to a candidate. */
  expectCandidates: string[];
  /** Proven flows that must NOT be candidates, as `input -> reason-fragment`. */
  expectRefused?: Array<[string, RegExp]>;
}

const CASES: Case[] = [
  {
    name: 'lovable / tanstack start + supabase (server fns, validated payload)',
    pkg: { dependencies: { '@tanstack/react-start': '1', zod: '3', '@supabase/supabase-js': '2' } },
    files: {
      'src/lib/tasks.functions.ts': `
        import { createServerFn } from "@tanstack/react-start";
        import { z } from "zod";
        import { createClient } from "@supabase/supabase-js";
        function getClient() { return createClient(process.env.URL, process.env.KEY); }
        export const createTask = createServerFn({ method: "POST" })
          .inputValidator((i) => z.object({ title: z.string().min(1).max(200) }).parse(i))
          .handler(async ({ data }) => { await getClient().from("tasks").insert({ title: data.title }); });
      `,
    },
    // A request value in a parameterized insert is reachability signal, not a blockable pattern.
    expectCandidates: [],
    expectRefused: [['title', /not a blockable pattern/]],
  },
  {
    name: 'express + axios + fs + child_process (the high-signal families)',
    pkg: { dependencies: { express: '4', axios: '1' } },
    files: {
      'src/server.ts': `
        import express from "express";
        import fs from "node:fs";
        import { exec } from "node:child_process";
        import axios from "axios";
        const app = express();
        app.post("/proxy", async (req, res) => { await axios.get(req.body.target); res.end(); });
        app.post("/download", (req, res) => { res.end(fs.readFileSync(req.body.file)); });
        app.post("/convert", (req, res) => { exec(req.body.cmd); res.end(); });
        app.get("/search", (req, res) => { res.end(fs.readFileSync(req.query.doc)); });
      `,
    },
    expectCandidates: [
      'ssrf @ post.target',
      'path-traversal @ post.file',
      'command-injection @ post.cmd',
      'path-traversal @ get.doc',
    ],
  },
  {
    name: 'next app router (file-based dynamic route) + server action',
    pkg: { dependencies: { next: '15' } },
    files: {
      'app/api/render/route.ts': `
        import fs from "node:fs";
        export async function POST(request) {
          const { template } = await request.json();
          return new Response(fs.readFileSync(template));
        }
      `,
      'app/actions.ts': `
        'use server';
        import { exec } from "node:child_process";
        export async function report(input) { exec(input.job); }
      `,
    },
    expectCandidates: ['path-traversal @ post.template', 'command-injection @ post.job'],
  },
  {
    name: 'fastify + pg (raw sql vs bound values)',
    pkg: { dependencies: { fastify: '4', pg: '8' } },
    files: {
      'src/app.ts': `
        import Fastify from "fastify";
        import { Pool } from "pg";
        const pool = new Pool();
        const app = Fastify();
        app.post("/raw", async (req, reply) => { await pool.query(req.body.sql); reply.send(); });
        app.post("/safe", async (req, reply) => { await pool.query("select 1 where id=$1", [req.body.id]); reply.send(); });
      `,
    },
    expectCandidates: ['sql-injection @ post.sql'],
    expectRefused: [['id', /not a blockable pattern/]],
  },
  {
    name: 'supabase edge function (deno) with an outbound callback',
    pkg: {},
    files: {
      'supabase/functions/notify/index.ts': `
        Deno.serve(async (req) => {
          const { hook } = await req.json();
          await fetch(hook, { method: "POST" });
          return new Response("ok");
        });
      `,
    },
    expectCandidates: ['ssrf @ post.hook'],
  },
  {
    name: 'unaddressable + unmodelled shapes (must yield nothing)',
    pkg: { dependencies: { express: '4', '@supabase/supabase-js': '2' } },
    files: {
      'src/edge.ts': `
        import express from "express";
        import fs from "node:fs";
        import { createClient } from "@supabase/supabase-js";
        const db = createClient("u", "k");
        const app = express();
        // A route param has no runtime coordinate at all.
        app.get("/t/:tenant/f", (req, res) => { res.end(fs.readFileSync(req.params.tenant)); });
        // A dynamic computed key cannot be pinned.
        app.post("/dyn", async (req, res) => { const k = req.body.which; await db.from("t").insert({ v: req.body[k] }); res.end(); });
        // A spread hides which field reaches the sink.
        app.post("/spread", async (req, res) => { await db.from("t").insert({ ...req.body }); res.end(); });
      `,
    },
    expectCandidates: [],
  },
];

const maps = new Map<string, SiteInputMap>();
let dirs: string[] = [];

beforeAll(async () => {
  for (const c of CASES) {
    const d = mkdtempSync(join(tmpdir(), 'ps-corpus-'));
    dirs.push(d);
    for (const [rel, body] of Object.entries(c.files)) {
      const p = join(d, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, body);
    }
    writeFileSync(join(d, 'package.json'), JSON.stringify(c.pkg));
    const { map, error } = await buildInputMap(d);
    expect(error, `${c.name}: ${error}`).toBeUndefined();
    maps.set(c.name, map!);
  }
}, 120_000);
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Every compiled candidate as `family @ runtimeParameter`. */
function candidatesOf(map: SiteInputMap): string[] {
  const out: string[] = [];
  for (const ep of map.endpoints) {
    const coord = new Map(ep.inputs.map((i) => [i.name, i.runtimeParameter]));
    for (const f of ep.flows) {
      if (!f.ruleGeneratable) continue;
      out.push(`${f.candidateFamily} @ ${coord.get(f.input)}`);
    }
  }
  return out.sort();
}

describe('golden corpus', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      it('compiles exactly the expected candidates — no wrong-input pins', () => {
        const got = candidatesOf(maps.get(c.name)!);
        const want = [...c.expectCandidates].sort();
        // A candidate nobody declared is a WRONG-INPUT pin: the metric that must stay at zero.
        expect(got.filter((g) => !want.includes(g)), 'unexpected candidate(s)').toEqual([]);
        expect(got).toEqual(want); // and no silent recall loss
      });

      it('refuses the flows that are proven but not blockable, with a reason', () => {
        const map = maps.get(c.name)!;
        for (const [input, reason] of c.expectRefused ?? []) {
          const flows = map.endpoints.flatMap((e) => e.flows).filter((f) => f.input === input);
          expect(flows.length, `no flow for input ${input}`).toBeGreaterThan(0);
          const refused = flows.filter((f) => f.ruleGeneratable === false);
          expect(refused.length).toBeGreaterThan(0);
          expect(refused.map((f) => (f.ruleGeneratableReasons ?? []).join(' ')).join(' ')).toMatch(reason);
        }
      });

      it('never emits a candidate whose input lacks a runtime coordinate', () => {
        const map = maps.get(c.name)!;
        for (const ep of map.endpoints) {
          const coord = new Map(ep.inputs.map((i) => [i.name, i.runtimeParameter]));
          for (const f of ep.flows.filter((x) => x.ruleGeneratable)) {
            expect(coord.get(f.input), `${f.input} is a candidate without a coordinate`).toBeTruthy();
          }
        }
      });
    });
  }

  it('reports corpus-wide metrics (the numbers that gate auto-promotion)', () => {
    let candidates = 0, precise = 0, heuristic = 0, refusedWithReason = 0, noCoordinate = 0;
    for (const c of CASES) {
      for (const ep of maps.get(c.name)!.endpoints) {
        for (const i of ep.inputs) if (!i.runtimeParameter) noCoordinate++;
        for (const f of ep.flows) {
          if (f.confidence === 'precise') precise++; else heuristic++;
          if (f.ruleGeneratable) candidates++;
          else if ((f.ruleGeneratableReasons ?? []).length > 0) refusedWithReason++;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`corpus: ${CASES.length} projects · ${candidates} candidates · ${precise} precise / ${heuristic} heuristic flows · ${refusedWithReason} refused-with-reason · ${noCoordinate} inputs without a coordinate`);
    expect(candidates).toBeGreaterThan(0);          // the compiler does something
    expect(refusedWithReason).toBeGreaterThan(0);   // and refuses a lot, explicitly
    // Every non-candidate must explain itself: silence is what makes a map untrustworthy.
    for (const c of CASES) {
      for (const ep of maps.get(c.name)!.endpoints) {
        for (const f of ep.flows.filter((x) => x.ruleGeneratable === false)) {
          expect(f.ruleGeneratableReasons?.length, `${c.name}/${f.input}: refused without a reason`).toBeGreaterThan(0);
        }
      }
    }
  });
});
