import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { isProvenFlow } from '../../src/map/coordinates.js';
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
  /**
   * `stack`: a project shape a builder really generates — measures recall and correct pinning.
   * `adversarial`: app code CONSTRUCTED to look dangerous. A permanent category, not a bag of
   * regressions: every false-candidate class we have found came from code that merely resembled a
   * dangerous API, so the corpus has to contain lookalikes on purpose. These cases must produce a
   * visible surface (inputs, usually sinks) and still compile no rule.
   */
  kind?: 'stack' | 'adversarial';
  pkg: Record<string, unknown>;
  files: Record<string, string>;
  /** `family @ runtimeParameter` for every flow that SHOULD compile to a candidate. */
  expectCandidates: string[];
  /** Proven flows that must NOT be candidates, as `input -> reason-fragment`. */
  expectRefused?: Array<[string, RegExp]>;
}

const ADVERSARIAL: Case[] = [
  {
    name: 'adversarial: app code whose exports collide with dangerous API names',
    kind: 'adversarial',
    pkg: { dependencies: { express: '4' } },
    files: {
      'src/util.ts': `
        export function exec(x) { return x.length }
        export function query(x) { return x }
        export function readFileSync(p) { return p }
        export function fetch(u) { return { u } }
      `,
      'src/server.ts': `
        import * as helper from "./util";
        import { fetch, exec } from "./util";
        import express from "express";
        const app = express();
        // Namespace member calls AND named imports, both from a relative module.
        app.post("/ns", (req, res) => {
          helper.exec(req.body.cmd); helper.query(req.body.sql); helper.readFileSync(req.body.path);
          res.end();
        });
        app.post("/named", (req, res) => { fetch(req.body.url); exec(req.body.cmd2); res.end(); });
      `,
    },
    expectCandidates: [],
  },
  {
    name: 'adversarial: untraceable receivers in a file that imports real db clients',
    kind: 'adversarial',
    pkg: { dependencies: { express: '4', pg: '8', '@supabase/supabase-js': '2' } },
    files: {
      'src/server.ts': `
        import { Pool } from "pg";
        import { createClient } from "@supabase/supabase-js";
        import express from "express";
        const app = express();
        // The package is only INFERRED from the file's imports; the receivers are app objects.
        app.post("/raw", (req, res) => { res.locals.db.query(req.body.sql); res.end(); });
        app.post("/from", (req, res) => { res.locals.sb.from("t").insert({ v: req.body.v }); res.end(); });
      `,
    },
    expectCandidates: [],
    expectRefused: [['sql', /inferred from the file's other imports/]],
  },
  {
    name: 'adversarial: parameters shadowing dangerous globals',
    kind: 'adversarial',
    pkg: { dependencies: { express: '4' } },
    files: {
      'src/server.ts': `
        import express from "express";
        const app = express();
        app.post("/shadow", (req, res) => {
          const send = (fetch) => fetch(req.body.url);
          send((u) => ({ u }));
          const run = (eval2) => eval2(req.body.code);
          run((c) => c);
          res.end();
        });
      `,
    },
    expectCandidates: [],
  },
  {
    name: 'adversarial: one field name read from two request namespaces, addressed separately',
    kind: 'adversarial',
    pkg: { dependencies: { express: '4' } },
    files: {
      // `params.id` and `query.id` share a NAME but not an address, so they are two inputs. Name-keyed
      // extraction kept one of them and let its coordinate stand for both, which pinned a rule to
      // `get.id` for data arriving in the path segment. Now each is addressed on its own: the query read
      // earns `get.id`, the route param earns nothing (the resolver cannot reach it). Both source orders
      // are covered because the order dependence is what made it a bug.
      'src/a.ts': `
        import express from "express";
        import fs from "node:fs";
        const app = express();
        app.get("/qp/:id", ({ params: p, query: q }, res) => { fs.readFileSync(q.id); fs.readFileSync(p.id); res.end(); });
      `,
      'src/b.ts': `
        import express from "express";
        import fs from "node:fs";
        const app = express();
        app.get("/pq/:id", ({ params: p, query: q }, res) => { fs.readFileSync(p.id); fs.readFileSync(q.id); res.end(); });
      `,
    },
    expectCandidates: ['path-traversal @ get.id', 'path-traversal @ get.id'],
    expectRefused: [['id', /route parameters are not exposed/]],
  },
  {
    name: 'adversarial: a validator field and the sink read address different namespaces',
    kind: 'adversarial',
    pkg: { dependencies: { express: '4', zod: '3' } },
    files: {
      // The schema describes the BODY; the sink consumes the QUERY. Both are called `id`, and grouping
      // inputs by name made the schema's `post.id` the only surviving entry — so the candidate pinned a
      // parameter the payload never travels in. As separate identities the query read is pinned correctly
      // and the declared-but-unread body field simply has no proven flow.
      'src/server.ts': `
        import express from "express";
        import fs from "node:fs";
        import { z } from "zod";
        const app = express();
        app.post("/mismatch", (req, res) => {
          z.object({ id: z.string() }).parse(req.body);
          res.end(fs.readFileSync(req.query.id));
        });
        app.post("/agree", (req, res) => {
          z.object({ doc: z.string() }).parse(req.body);
          res.end(fs.readFileSync(req.body.doc));
        });
      `,
    },
    // `/agree` must still compile: a validated body field read by the sink is the common good case.
    expectCandidates: ['path-traversal @ get.id', 'path-traversal @ post.doc'],
    // The schema's `post:id` is declared but never read by the sink — proven-nothing, not blockable.
    expectRefused: [['id', /no proven local read/]],
  },
  {
    name: 'adversarial: sibling expressions must not contaminate each other',
    kind: 'adversarial',
    pkg: { dependencies: { express: '4' } },
    files: {
      'src/server.ts': `
        import express from "express";
        import fs from "node:fs";
        import { exec } from "node:child_process";
        const STATIC = "ls -la";
        const app = express();
        // Only ONE pairing is real: path -> readFileSync. \`label\` reaches no sink, and the exec call
        // takes no request data at all — an inventory-level "both present" must not become a flow.
        app.post("/two", (req, res) => {
          const label = req.body.label;
          fs.readFileSync(req.body.path);
          exec(STATIC);
          res.end(label);
        });
      `,
    },
    expectCandidates: ['path-traversal @ post.path'],
  },
];

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
  {
    name: 'express + a client in lib/ (the layout generated apps actually use)',
    pkg: { dependencies: { express: '4', '@supabase/supabase-js': '2', pg: '8' } },
    files: {
      // The handler's file imports the CLIENT, not the driver. The receiver therefore resolves to a
      // relative specifier, and treating that as app code made these sinks vanish — which also broke the
      // package join a server needs to connect a CVE in `pg` to the endpoint that reaches it.
      'src/lib/db.ts': `
        import { createClient } from "@supabase/supabase-js";
        export const db = createClient(process.env.URL, process.env.KEY);
      `,
      'src/lib/pool.ts': `
        import { Pool } from "pg";
        export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      `,
      'src/server.ts': `
        import express from "express";
        import { db } from "./lib/db";
        import { pool } from "./lib/pool";
        const app = express();
        app.post("/tasks", async (req, res) => { await db.from("tasks").insert({ title: req.body.title }); res.end(); });
        app.post("/report", async (req, res) => { await pool.query(req.body.sql); res.end(); });
      `,
    },
    // The raw query is a blockable pattern; the inserted row value is context, not a rule.
    expectCandidates: ['sql-injection @ post.sql'],
    expectRefused: [['title', /not a blockable pattern/]],
  },
];

const ALL: Case[] = [...CASES, ...ADVERSARIAL];

const maps = new Map<string, SiteInputMap>();
let dirs: string[] = [];

beforeAll(async () => {
  for (const c of ALL) {
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

/**
 * Every compiled candidate as `family @ runtimeParameter`. Correlation is by input IDENTITY: keying this
 * by name would collapse `get:id` and `post:id` into one entry — the same lossy key that caused the
 * wrong-pin bugs, which would make the harness report the wrong coordinate for a correct candidate.
 */
function candidatesOf(map: SiteInputMap): string[] {
  const out: string[] = [];
  for (const ep of map.endpoints) {
    const coord = new Map(ep.inputs.map((i) => [i.id, i.runtimeParameter]));
    for (const f of ep.flows) {
      if (!f.ruleGeneratable) continue;
      out.push(`${f.candidateFamily} @ ${coord.get(f.inputId)}`);
    }
  }
  return out.sort();
}

describe('golden corpus', () => {
  for (const c of ALL) {
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
          const coord = new Map(ep.inputs.map((i) => [i.id, i.runtimeParameter]));
          for (const f of ep.flows.filter((x) => x.ruleGeneratable)) {
            expect(coord.get(f.inputId), `${f.inputId} is a candidate without a coordinate`).toBeTruthy();
          }
        }
      });

      it('gives every input a unique identity, and every flow a real one to point at', () => {
        const map = maps.get(c.name)!;
        for (const ep of map.endpoints) {
          const ids = ep.inputs.map((i) => i.id);
          expect(new Set(ids).size, `${ep.route ?? ep.name}: duplicate input ids`).toBe(ids.length);
          for (const f of ep.flows) expect(ids, `flow points at unknown input ${f.inputId}`).toContain(f.inputId);
        }
      });
    });
  }

  // An adversarial case that found NOTHING would pass its zero-candidate assertion for the wrong
  // reason — a parser bug or a bad fixture would read as a security property. Each one has to prove it
  // actually saw the handler and the request fields, and only then that it compiled no rule.
  it('adversarial cases detect a real surface and still refuse to compile a rule', () => {
    for (const c of ADVERSARIAL) {
      const map = maps.get(c.name)!;
      const inputs = map.endpoints.flatMap((e) => e.inputs);
      expect(map.endpoints.length, `${c.name}: no endpoint detected — the fixture proves nothing`).toBeGreaterThan(0);
      expect(inputs.length, `${c.name}: no inputs detected — the fixture proves nothing`).toBeGreaterThan(0);
      const generatable = map.endpoints.flatMap((e) => e.flows).filter((f) => f.ruleGeneratable);
      const declared = new Set(c.expectCandidates);
      const coord = new Map(map.endpoints.flatMap((e) => e.inputs).map((i) => [i.id, i.runtimeParameter]));
      expect(generatable.filter((f) => !declared.has(`${f.candidateFamily} @ ${coord.get(f.inputId)}`))).toEqual([]);
    }
  });

  it('keeps a standing adversarial category (lookalikes are how every false candidate got in)', () => {
    // Guards against the category quietly emptying out; the classes listed are the ones that have
    // actually produced false candidates, so losing one should fail loudly.
    expect(ADVERSARIAL.length).toBeGreaterThanOrEqual(6);
    const names = ADVERSARIAL.map((c) => c.name).join(' | ');
    for (const cls of ['collide with dangerous API names', 'untraceable receivers', 'shadowing dangerous globals', 'two request namespaces', 'sibling expressions', 'different namespaces']) {
      expect(names, `missing adversarial class: ${cls}`).toContain(cls);
    }
  });

  it('reports corpus-wide metrics (the numbers that gate auto-promotion)', () => {
    let candidates = 0, refusedWithReason = 0, noCoordinate = 0;
    const tiers = new Map<string, number>();
    for (const c of ALL) {
      for (const ep of maps.get(c.name)!.endpoints) {
        for (const i of ep.inputs) if (!i.runtimeParameter) noCoordinate++;
        for (const f of ep.flows) {
          tiers.set(f.confidence, (tiers.get(f.confidence) ?? 0) + 1);
          if (f.ruleGeneratable) candidates++;
          else if ((f.ruleGeneratableReasons ?? []).length > 0) refusedWithReason++;
        }
      }
    }
    // eslint-disable-next-line no-console
    const byTier = [...tiers].sort().map(([t, n]) => `${n} ${t}`).join(', ');
    console.log(`corpus: ${CASES.length} stack + ${ADVERSARIAL.length} adversarial projects · ${candidates} candidates · flows: ${byTier} · ${refusedWithReason} refused-with-reason · ${noCoordinate} inputs without a coordinate`);
    expect(candidates).toBeGreaterThan(0);          // the compiler does something
    expect(refusedWithReason).toBeGreaterThan(0);   // and refuses a lot, explicitly
    // Every non-candidate must explain itself: silence is what makes a map untrustworthy.
    for (const c of ALL) {
      for (const ep of maps.get(c.name)!.endpoints) {
        for (const f of ep.flows.filter((x) => x.ruleGeneratable === false)) {
          expect(f.ruleGeneratableReasons?.length, `${c.name}/${f.input}: refused without a reason`).toBeGreaterThan(0);
        }
      }
    }
  });
});
