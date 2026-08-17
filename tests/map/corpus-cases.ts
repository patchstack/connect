// The golden corpus cases, extracted so they can be referenced from outside the corpus test.
//
// `tests/map/capabilities.test.ts` asserts that every rule-generatable capability names an adversarial
// case that covers it. That check used to grep this file for an API name, which any comment or unrelated
// fixture could satisfy — coverage has to be a structural link between two declarations, so the cases
// carry stable ids and the capability contract references them.
//
// `kind` is documented on the interface: `stack` measures recall on shapes builders really generate,
// `adversarial` is app code CONSTRUCTED to look dangerous and must compile nothing.

export interface Case {
  /**
   * Stable identity, referenced from outside this file — `CAPABILITY_CONTROLS` names the adversarial case
   * that covers each rule-generatable capability by this id. Renaming one breaks that reference loudly,
   * which is the point: coverage is a link between two declarations, not a string that happens to appear
   * in the file.
   */
  id: string;
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

export const ADVERSARIAL: Case[] = [
  {
    id: 'adv/lookalike-exports',
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
    id: 'adv/inferred-db-receivers',
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
    id: 'adv/local-eval-lookalikes',
    name: 'adversarial: a locally-declared Function and a member .eval() are not code injection',
    kind: 'adversarial',
    pkg: { dependencies: { express: '4' } },
    files: {
      'src/server.ts': `
        import express from "express";
        const app = express();
        // A local declaration wins over the global: this Function is app code, not the compiler entry.
        function Function(src) { return { src } }
        app.post("/localfn", (req, res) => { Function(req.body.code); res.end(); });
        // A dangerous METHOD NAME on a receiver we cannot trace is not a dangerous API.
        app.post("/member", (req, res) => { res.locals.vm.eval(req.body.payload); res.end(); });
      `,
    },
    expectCandidates: [],
  },
  {
    id: 'adv/shadowed-globals',
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
    id: 'adv/same-name-two-namespaces',
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
    id: 'adv/validator-vs-sink-namespace',
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
    id: 'adv/traced-package-wrong-api',
    name: 'adversarial: a traced package that does not establish the API',
    kind: 'adversarial',
    pkg: { dependencies: { express: '4', '@apollo/client': '3' } },
    files: {
      // `.query()` is a generic method name. An ApolloClient instance resolves to a REAL dependency, so
      // attribution alone admits it — and a GraphQL call became a precise SQL-injection candidate. Package
      // provenance is not API provenance.
      'src/lib/gql.ts': `
        import { ApolloClient } from "@apollo/client";
        export const client = new ApolloClient({ uri: "https://api.example.com" });
      `,
      'src/server.ts': `
        import express from "express";
        import { client } from "./lib/gql";
        const app = express();
        app.post("/graphql", async (req, res) => { await client.query(req.body.sql); res.end(); });
      `,
    },
    expectCandidates: [],
    expectRefused: [['sql', /does not establish a db API/]],
  },
  {
    id: 'adv/sibling-expressions',
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

export const CASES: Case[] = [
  {
    id: 'stack/tanstack-supabase',
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
    id: 'stack/express-axios-fs-exec',
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
    id: 'stack/next-app-router',
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
    id: 'stack/fastify-pg',
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
    id: 'stack/supabase-edge-fn',
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
    id: 'stack/unaddressable-unmodelled',
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
    id: 'stack/express-client-in-lib',
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
