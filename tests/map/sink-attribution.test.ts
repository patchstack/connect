import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

// A dangerous NAME is not a dangerous API. `import { fetch } from './util'` and a callback parameter
// named `fetch` are indistinguishable from the global by name alone, and treating either as an HTTP
// request produced a FALSE SSRF candidate — a direct violation of the zero-false-candidate goal. A bare
// call now has to be justified: it resolves to a module that plausibly provides that API, or it is a
// genuine unresolved global (only fetch / eval / Function ever are).
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-attrib-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
  writeFileSync(join(dir, 'src', 'util.ts'), 'export function fetch(u) { return { u }; }\nexport function readFile(p) { return p; }\nexport function exec(c) { return c; }\n');

  // Impostors: same names, app code.
  writeFileSync(join(dir, 'src', 'impostors.ts'), `
    import { fetch, readFile, exec } from "./util";
    import express from "express";
    const app = express();
    app.post("/local-helpers", (req, res) => {
      fetch(req.body.url); readFile(req.body.name); exec(req.body.cmd);
      res.end();
    });
  `);
  // A parameter shadowing the global.
  writeFileSync(join(dir, 'src', 'shadowed.ts'), `
    import express from "express";
    const app = express();
    function withClient(cb) { return cb((u) => ({ u })); }
    app.post("/shadowed", (req, res) => { withClient((fetch) => { fetch(req.body.url); }); res.end(); });
  `);
  // The genuine articles.
  writeFileSync(join(dir, 'src', 'real.ts'), `
    import express from "express";
    import { readFile } from "node:fs/promises";
    import { exec } from "node:child_process";
    const app = express();
    app.post("/real-fetch", async (req, res) => { await fetch(req.body.url); res.end(); });
    app.post("/real-fs", async (req, res) => { await readFile(req.body.name); res.end(); });
    app.post("/real-exec", (req, res) => { exec(req.body.cmd); res.end(); });
    app.post("/real-fn", (req, res) => { const f = new Function("a", req.body.code); f(1); res.end(); });
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const candidates = async () => {
  const { map } = await buildInputMap(dir);
  return map!.endpoints.flatMap((e) => e.flows.filter((f) => f.ruleGeneratable).map((f) => ({ route: e.route, ...f })));
};

describe('sink attribution', () => {
  it.each(['/local-helpers', '/shadowed'])('produces NO candidate for %s', async (route) => {
    expect((await candidates()).filter((c) => c.route === route)).toEqual([]);
  });

  it('does not even inventory an impostor as a dangerous sink', async () => {
    const { map } = await buildInputMap(dir);
    for (const route of ['/local-helpers', '/shadowed']) {
      const ep = map!.endpoints.find((e) => e.route === route)!;
      expect(ep.sinks.filter((s) => ['http', 'fs', 'exec', 'eval'].includes(s.kind))).toEqual([]);
    }
  });

  it.each([
    ['/real-fetch', 'ssrf'],
    ['/real-fs', 'path-traversal'],
    ['/real-exec', 'command-injection'],
    ['/real-fn', 'code-injection'],
  ])('still finds the genuine %s candidate (%s)', async (route, family) => {
    const found = (await candidates()).filter((c) => c.route === route);
    expect(found.map((f) => f.candidateFamily)).toContain(family);
  });

  it('models `new Function` — the code is the LAST argument, earlier ones are parameter names', async () => {
    const { map } = await buildInputMap(dir);
    const ep = map!.endpoints.find((e) => e.route === '/real-fn')!;
    // Previously impossible: NewExpression was inventoried but never indexed, so it could not be located
    // and every flow into it stayed heuristic.
    const f = ep.flows.find((x) => x.input === 'code')!;
    expect(f.confidence).toBe('exact-local');
    expect(f.argumentRole).toBe('code');
    expect(f.candidateFamily).toBe('code-injection');
  });
});
