import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import type { ApiInvocation } from '../../src/map/types.js';

// An invocation record makes TWO claims — a package and an API name — and tracing the value only
// establishes the first. This file is about the second, because getting it wrong is worse than
// recording nothing: a consumer comparing the inventory against an advisory's affected functions
// reads a name that appears in no advisory, and takes the absence of the real name as evidence.
//
// The shapes here are the four ways a name can reach a package, and only two of them yield a name
// the package actually exports.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-naming-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { express: '4', json5: '2.2.1', lodash: '4', pg: '8', winston: '3' },
  }));

  // A local function that RETURNS a dependency value. `loadConfig` is this app's own function; json5
  // has no such export, and its return expression rooting in JSON5 does not make it one.
  writeFileSync(join(dir, 'src', 'config.js'), `
    const JSON5 = require("json5");
    const { readFileSync } = require("node:fs");
    function loadConfig() { return JSON5.parse(readFileSync("./config.json5", "utf8")); }
    module.exports = { loadConfig };
  `);

  // A local factory returning a real dependency object. Calling a METHOD on what it returns is a
  // call into pg's surface — the positive control that keeps the fix from becoming a blanket refusal.
  writeFileSync(join(dir, 'src', 'db.js'), `
    const { Pool } = require("pg");
    function getDb() { return new Pool(); }
    module.exports = { getDb };
  `);

  // A pass-through re-export: the value never stops being lodash's, and the intermediate module
  // renamed it on the way in — so the package's name for it is `merge`, not `deepMerge`.
  writeFileSync(join(dir, 'src', 'util.js'), `
    const { merge: deepMerge } = require("lodash");
    module.exports = { deepMerge };
  `);

  writeFileSync(join(dir, 'src', 'server.js'), `
    const express = require("express");
    const { createLogger } = require("winston");
    const { pick: choose } = require("lodash");
    const { loadConfig } = require("./config");
    const { getDb } = require("./db");
    const { deepMerge } = require("./util");
    const log = createLogger({});
    const app = express();

    app.get("/config", (req, res) => { res.json({ theme: loadConfig().theme }); });
    app.get("/rows", async (req, res) => { res.json(await getDb().query("select 1")); });
    app.post("/merge", (req, res) => { res.json(deepMerge({}, { ok: true })); });
    app.get("/log", (req, res) => { log("served"); res.end(); });
    app.get("/pick", (req, res) => { res.json(choose({ a: 1 }, ["a"])); });

    module.exports = app;
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const inventory = async (): Promise<ApiInvocation[]> => {
  const { map } = await buildInputMap(dir);
  return map!.apiInvocations ?? [];
};
const symbols = (list: ApiInvocation[]): string[] => list.map((i) => `${i.package}.${i.symbol}`);

describe('a name the app chose is not a package API', () => {
  it('does not record a local function as an API of the package its return value came from', async () => {
    const found = symbols(await inventory());

    // The defect this fixes: `json5.loadConfig`. json5's surface is `parse`/`stringify` — a consumer
    // checking whether the vulnerable function is called finds neither, and a name that is not json5's.
    expect(found).not.toContain('json5.loadConfig');
    expect(found.filter((s) => s.startsWith('json5.') && s !== 'json5.parse')).toEqual([]);
  });

  it('does not record a factory result called directly under the app’s name for it', async () => {
    const found = symbols(await inventory());

    // `const log = createLogger({}); log("served")` — the value is winston's, the name is not.
    expect(found).not.toContain('winston.log');
    // And the call that IS nameable is still there, so this is a naming rule and not a lost trace.
    expect(found).toContain('winston.createLogger');
  });

  it('still records a method called on a value a local factory returned', async () => {
    const list = await inventory();
    const query = list.find((i) => i.package === 'pg' && i.symbol === 'query');

    // `getDb().query(...)`. The receiver's name is the app's, which is why no receiver is reported —
    // but `query` is pg's own method, and dropping it would trade a wrong record for a missing one.
    expect(query, 'a method on a dependency value belongs to that dependency').toBeDefined();
    expect(query!.receiver).toBeUndefined();
    expect(query!.resolution).toBe('reexport');
  });

  it('records a pass-through re-export under the package’s name, not the app’s alias', async () => {
    const found = symbols(await inventory());

    // `require("lodash").merge` re-exported as `deepMerge`. The value is lodash's own binding, so the
    // call is real evidence — under `merge`, the name an advisory would use.
    expect(found).toContain('lodash.merge');
    expect(found).not.toContain('lodash.deepMerge');
  });

  it('resolves a renamed CommonJS destructure back to the exported name', async () => {
    const found = symbols(await inventory());

    // `const { pick: choose } = require("lodash")` in the calling file itself — the same rename, one
    // hop shorter. An advisory names `pick`; `choose` is this app's word for it.
    expect(found).toContain('lodash.pick');
    expect(found).not.toContain('lodash.choose');
  });
});

describe('a call it cannot name is counted, not invented', () => {
  it('counts an unnameable dependency call as ambiguous rather than as a recorded call', async () => {
    const { map } = await buildInputMap(dir);
    const c = map!.coverage as Record<string, number>;

    // `loadConfig()` and `log()` are dependency-derived and unnameable. Counting them as `dependency`
    // would make that bucket claim records the inventory does not hold; counting them as `local` would
    // file a real miss as a correct exclusion.
    expect(c.callsAmbiguous).toBeGreaterThanOrEqual(2);
    expect(c.callsDependency + c.callsLocal + c.callsAmbiguous).toBe(c.callsTotal);
  });
});
