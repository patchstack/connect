import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { isProvenFlow } from '../../src/map/coordinates.js';

// Track 2, step 1 — adapter summaries. Which ARGUMENT received the value decides which mitigation class
// applies, so a candidate compiler cannot exist without it: `url` vs `body`, `path` vs `content`,
// `command` vs `args`, raw `sql` vs bound `values`.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-roles-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '4', axios: '1', pg: '8' } }));
  writeFileSync(join(dir, 'src', 's.ts'), `
    import express from "express";
    import fs from "node:fs";
    import { exec } from "node:child_process";
    import axios from "axios";
    import { Pool } from "pg";
    import { createClient } from "@supabase/supabase-js";
    const db = createClient("u","k");
    const pool = new Pool();
    const app = express();
    app.post("/fetch", async (req,res) => { await axios.get(req.body.webhookUrl); res.end(); });
    app.post("/post", async (req,res) => { await axios.post("https://api.example.com", req.body.payload); res.end(); });
    app.post("/read", (req,res) => { res.end(fs.readFileSync(req.body.filename)); });
    app.post("/write", (req,res) => { fs.writeFileSync("/tmp/x", req.body.contents); res.end(); });
    app.post("/run", (req,res) => { exec(req.body.command); res.end(); });
    app.post("/sql", async (req,res) => { await pool.query(req.body.rawSql); res.end(); });
    app.post("/sqlparam", async (req,res) => { await pool.query("select 1 where a=$1", [req.body.id]); res.end(); });
    app.post("/save", async (req,res) => { await db.from("t").insert({ title: req.body.title }); res.end(); });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const flow = async (route: string, input: string) => {
  const { map } = await buildInputMap(dir);
  const ep = map!.endpoints.find((e) => e.route === route)!;
  return ep.flows.find((f) => f.input === input && isProvenFlow(f.confidence))!;
};

describe('argument roles', () => {
  it.each([
    ['/fetch', 'webhookUrl', 'url', 'ssrf'],
    ['/read', 'filename', 'path', 'path-traversal'],
    ['/run', 'command', 'command', 'command-injection'],
    ['/sql', 'rawSql', 'sql', 'sql-injection'],
  ])('%s: %s lands in the %s argument → %s candidate, rule-generatable', async (route, input, role, family) => {
    const f = await flow(route, input);
    expect(f.argumentRole).toBe(role);
    expect(f.candidateFamily).toBe(family);
    expect(f.ruleGeneratable).toBe(true);
    expect(f.ruleGeneratableReasons).toEqual([]);
  });

  // The distinctions that stop a generator over-reaching. Each of these IS a proven flow, but none is a
  // blockable pattern by itself — the review called out path-vs-contents and generic db values by name.
  it.each([
    ['/write', 'contents', 'content', 'fs'],
    ['/save', 'title', 'values', 'db'],
    ['/post', 'payload', 'body', 'http'],
    ['/sqlparam', 'id', 'values', 'db'],
  ])('%s: %s lands in the %s argument of a %s sink → proven but NOT generatable', async (route, input, role, _kind) => {
    const f = await flow(route, input);
    // Proven either way, but the db rows are only `transformed-local`: `insert({ title: req.body.title })`
    // hands the sink an OBJECT containing the value, not the value. The payload still travels in
    // `post.title` — which is why a rule could be compiled at all — but what reaches the sink is not
    // exactly what arrived, and that is precisely what the tier is there to tell a server.
    expect(isProvenFlow(f.confidence)).toBe(true);
    expect(f.confidence).toBe(role === 'values' ? 'transformed-local' : 'exact-local');
    expect(f.argumentRole).toBe(role);
    expect(f.candidateFamily).toBeUndefined();
    expect(f.ruleGeneratable).toBe(false);
    expect(f.ruleGeneratableReasons!.join(' ')).toMatch(/not a blockable pattern on its own/);
  });

  it('a generatable candidate carries everything a compiler needs', async () => {
    const { map } = await buildInputMap(dir);
    const ep = map!.endpoints.find((e) => e.route === '/fetch')!;
    const f = ep.flows.find((x) => x.candidateFamily === 'ssrf')!;
    expect(ep.method).toBe('POST');            // route + method
    expect(ep.route).toBe('/fetch');
    expect(ep.fingerprint).toBeTruthy();        // staleness guard
    expect(ep.inputs.find((i) => i.name === 'webhookUrl')!.runtimeParameter).toBe('post.webhookUrl');
    expect(f.sink.package).toBe('axios');       // the dependency behind the sink
    expect(typeof f.sink.start).toBe('number'); // evidence span
  });
});
