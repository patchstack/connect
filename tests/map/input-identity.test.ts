import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { addressSpaceOf, inputIdOf, isProvenFlow } from '../../src/map/coordinates.js';

// An input's identity is (address space, full path) — NOT its name. Three separate wrong-pin bugs came
// from name-keying: two field names colliding across namespaces, and a validator field colliding with a
// read. Each was previously patched by REFUSING to emit a coordinate; with real identities the same code
// is addressed correctly instead, so this file asserts the pins rather than the refusals.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-ident-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '4', zod: '3' } }));
  writeFileSync(join(dir, 'src', 'app.ts'), `
    import express from "express";
    import fs from "node:fs";
    import { z } from "zod";
    const app = express();
    // One name, two namespaces, two sinks: each read must pin its own address.
    app.get("/both/:id", ({ params: p, query: q }, res) => {
      fs.readFileSync(q.id);
      fs.readFileSync(p.id);
      res.end();
    });
    // The schema declares a BODY field; the sink consumes the QUERY field of the same name.
    app.post("/mismatch", (req, res) => {
      z.object({ id: z.string() }).parse(req.body);
      res.end(fs.readFileSync(req.query.id));
    });
    // Transformation: the value reaches the sink inside a larger expression.
    app.post("/joined", (req, res) => { res.end(fs.readFileSync("/tmp/" + req.body.name)); });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ep = async (route: string) => {
  const { map } = await buildInputMap(dir);
  return map!.endpoints.find((e) => e.route === route)!;
};

describe('input identity', () => {
  it('is (space, path), so one name in two namespaces is two inputs', async () => {
    const e = await ep('/both/:id');
    expect(e.inputs.map((i) => i.id).sort()).toEqual(['get:id', 'route-param:id']);
    expect(e.inputs.filter((i) => i.name === 'id')).toHaveLength(2);
  });

  it('addresses each one on its own terms — the query field is pinned, the route param is not', async () => {
    const e = await ep('/both/:id');
    const byId = new Map(e.inputs.map((i) => [i.id, i]));
    expect(byId.get('get:id')!.runtimeParameter).toBe('get.id');
    expect(byId.get('route-param:id')!.runtimeParameter).toBeNull();
    // The candidate exists AND points at the query field only. Before identities, this endpoint either
    // pinned `get.id` for the path-segment read or refused both.
    const gen = e.flows.filter((f) => f.ruleGeneratable);
    expect(gen).toHaveLength(1);
    expect(gen[0]!.inputId).toBe('get:id');
    expect(gen[0]!.candidateFamily).toBe('path-traversal');
  });

  it('keeps a proven route-param flow visible while refusing to address it', async () => {
    const e = await ep('/both/:id');
    const flow = e.flows.find((f) => f.inputId === 'route-param:id' && isProvenFlow(f.confidence))!;
    expect(flow).toBeDefined();
    expect(flow.ruleGeneratable).toBe(false);
    expect(flow.ruleGeneratableReasons!.join(' ')).toMatch(/route parameters are not exposed/);
  });

  it('does not let a read in one space lend evidence to an input in another', async () => {
    const e = await ep('/mismatch');
    const post = e.flows.filter((f) => f.inputId === 'post:id');
    const get = e.flows.filter((f) => f.inputId === 'get:id');
    // The declared body field is never read by the sink…
    expect(post.every((f) => !isProvenFlow(f.confidence))).toBe(true);
    expect(post.every((f) => f.ruleGeneratable === false)).toBe(true);
    // …while the query field it shares a name with is proven and correctly pinned.
    expect(get.some((f) => isProvenFlow(f.confidence) && f.ruleGeneratable)).toBe(true);
  });

  it('every flow names an input that exists, and ids are unique per endpoint', async () => {
    const { map } = await buildInputMap(dir);
    for (const e of map!.endpoints) {
      const ids = e.inputs.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const f of e.flows) expect(ids).toContain(f.inputId);
    }
  });
});

describe('confidence taxonomy', () => {
  it('calls a direct argument read exact-local', async () => {
    const e = await ep('/both/:id');
    const f = e.flows.find((x) => x.inputId === 'get:id' && x.ruleGeneratable)!;
    expect(f.confidence).toBe('exact-local');
  });

  it('calls a read inside a larger expression transformed-local — still pinnable, not promotable', async () => {
    const e = await ep('/joined');
    const f = e.flows.find((x) => x.inputId === 'post:name')!;
    expect(f.confidence).toBe('transformed-local');
    expect(isProvenFlow(f.confidence)).toBe(true);
    // A rule can still be compiled: the payload arrives in `post.name` regardless of the concatenation.
    // The tier is the signal a server uses to require a probe or a human before blocking.
    expect(f.ruleGeneratable).toBe(true);
  });

  it('reports the schema version so a consumer can reject a shape it does not understand', async () => {
    const { map } = await buildInputMap(dir);
    expect(map!.version).toBe(3);
  });
});

// The v2 -> v3 changes are silent-failure shaped: `confidence === "precise"` is now permanently false
// rather than an error, so stale prose in the CLI or in the map's own notes would send a consumer down
// exactly that path. These guard the DOCUMENTED contract, which drifted from the code once already.
describe('the v3 contract describes itself accurately', () => {
  const TIERS = ['exact-local', 'transformed-local', 'imported', 'heuristic', 'unknown'];

  it('emits only tiers the schema declares', async () => {
    const { map } = await buildInputMap(dir);
    const seen = map!.endpoints.flatMap((e) => e.flows.map((f) => f.confidence));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((c) => !TIERS.includes(c))).toEqual([]);
  });

  it('never tells a consumer to look for a confidence value that no longer exists', async () => {
    const { map } = await buildInputMap(dir);
    const notes = map!.coverage.notes.join('\n');
    expect(notes).not.toMatch(/confidence "precise"|marked precise/);
    // …and does say what to require instead, including which field identifies the input.
    expect(notes).toMatch(/exact-local/);
    expect(notes).toMatch(/inputId/);
  });
});

describe('the identity helpers agree with the schema', () => {
  it('maps every body-ish source to the post space', () => {
    for (const s of ['json-body', 'form-body', 'multipart', 'body', 'server-fn-data'] as const) {
      expect(addressSpaceOf(s)).toBe('post');
    }
    expect(inputIdOf('json-body', 'a.b')).toBe('post:a.b');
    expect(inputIdOf('query', 'a')).toBe('get:a');
  });

  it('treats only the two local tiers as proven', () => {
    expect(['exact-local', 'transformed-local'].every(isProvenFlow)).toBe(true);
    expect(['imported', 'heuristic', 'unknown'].some(isProvenFlow)).toBe(false);
  });
});
