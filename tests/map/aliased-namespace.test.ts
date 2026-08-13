import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

// The request NAMESPACE decides the runtime coordinate, so it has to survive renamed destructuring.
// `({ query: q })` binds the local `q`; matching that local against the literal 'query' discarded the
// namespace, which mis-addressed the input two ways:
//   - a query-string field got `post.doc`  → a rule that can never match
//   - an aliased ROUTE PARAM got `post.id` → a coordinate for something the resolver cannot address,
//     defeating the whole point of returning null for route params.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-alias-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
  writeFileSync(join(dir, 'src', 'app.ts'), `
    import express from "express";
    import fs from "node:fs";
    const app = express();
    app.get("/plain", ({ query }, res) => { res.end(fs.readFileSync(query.doc)); });
    app.get("/renamed", ({ query: q }, res) => { res.end(fs.readFileSync(q.doc)); });
    app.get("/param/:id", ({ params: p }, res) => { res.end(fs.readFileSync(p.id)); });
    app.post("/bodyalias", ({ body: b }, res) => { res.end(fs.readFileSync(b.file)); });
    app.post("/nested", ({ query: q }, res) => { const { doc } = q; res.end(fs.readFileSync(doc)); });
    // The same namespace capture, one statement later instead of in the parameter list.
    app.get("/fromreq", (req, res) => { const { query: q } = req; res.end(fs.readFileSync(q.doc)); });
    app.get("/fromreq/:id", (req, res) => { const { params: p } = req; res.end(fs.readFileSync(p.id)); });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const input = async (route: string, name: string) => {
  const { map } = await buildInputMap(dir);
  const ep = map!.endpoints.find((e) => e.route === route)!;
  return { ep, field: ep.inputs.find((i) => i.name === name)! };
};

describe('aliased request namespaces', () => {
  it('keeps the namespace when the handler param is destructured plainly (control)', async () => {
    const { field } = await input('/plain', 'doc');
    expect(field).toMatchObject({ source: 'query', runtimeParameter: 'get.doc' });
  });

  it('keeps the namespace through a RENAMED destructuring', async () => {
    const { field } = await input('/renamed', 'doc');
    expect(field).toMatchObject({ source: 'query', runtimeParameter: 'get.doc' });
  });

  it('still refuses a coordinate for an aliased route param', async () => {
    const { ep, field } = await input('/param/:id', 'id');
    expect(field.source).toBe('route-param');
    expect(field.runtimeParameter).toBeNull();
    // …and therefore cannot become a candidate, however strong the flow evidence is.
    expect(ep.flows.filter((f) => f.input === 'id' && f.ruleGeneratable)).toEqual([]);
  });

  it('keeps an aliased body namespace', async () => {
    const { field } = await input('/bodyalias', 'file');
    expect(field).toMatchObject({ source: 'body', runtimeParameter: 'post.file' });
  });

  it('keeps the namespace when destructuring again from the alias', async () => {
    const { field } = await input('/nested', 'doc');
    expect(field).toMatchObject({ source: 'query', runtimeParameter: 'get.doc' });
  });

  it('captures the namespace when destructured from the request identifier itself', async () => {
    const { field } = await input('/fromreq', 'doc');
    // Previously invisible: no coordinate was mis-addressed, but the surface went unreported, which
    // reads as "nothing here" rather than "something we cannot address".
    expect(field).toMatchObject({ source: 'query', runtimeParameter: 'get.doc' });
  });

  it('still refuses a coordinate for a route param destructured that way', async () => {
    const { field } = await input('/fromreq/:id', 'id');
    expect(field.source).toBe('route-param');
    expect(field.runtimeParameter).toBeNull();
  });

  it('compiles candidates for the addressable ones only', async () => {
    const { map } = await buildInputMap(dir);
    const got = map!.endpoints
      .flatMap((e) => e.flows.filter((f) => f.ruleGeneratable).map((f) => `${e.route}:${f.input}`))
      .sort();
    // `/fromreq` is absent by design: the input is now VISIBLE, but its flow evidence is heuristic
    // (the alias is not yet tracked in the taint paths), so it must not compile a rule. Visible and
    // non-generatable is the safe half of this fix; making such flows precise is a separate change.
    expect(got).toEqual(['/bodyalias:file', '/nested:doc', '/plain:doc', '/renamed:doc']);
  });
});
