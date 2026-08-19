import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import type { InputMap } from '../../src/map/types.js';

// A dependency call is rarely written in the file that holds the route. The handler calls a helper, and
// the helper — in a file with no entry-point signal, which the walk therefore only scanned for imports —
// is where the API call lives. Before this, such an app reported the package as imported and no call at
// all: exactly the evidence an advisory whose precondition is *calling* the function needs.
//
// The pass follows ONE hop, from entry files only. That bound is the other half of what these tests pin:
// a bound nobody asserts is a bound that quietly becomes "every file".
let map: InputMap;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ps-hop-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { express: '4', json5: '2.2.1', lodash: '4' },
  }));

  // ONE hop from the entry file: the call this pass exists to find.
  writeFileSync(join(dir, 'src', 'config.js'), `
    const JSON5 = require("json5");
    const { readFileSync } = require("node:fs");
    const { summarise } = require("./deep");
    function loadConfig() { return JSON5.parse(readFileSync("./config.json5", "utf8")); }
    module.exports = { loadConfig, summarise };
  `);

  // TWO hops: reached only through config.js, which is itself a hop. Out of bounds by design.
  writeFileSync(join(dir, 'src', 'deep.js'), `
    const { pick } = require("lodash");
    function summarise(o) { return pick(o, ["theme"]); }
    module.exports = { summarise };
  `);

  writeFileSync(join(dir, 'src', 'server.js'), `
    const express = require("express");
    const { loadConfig, summarise } = require("./config");
    const app = express();
    app.get("/config", (req, res) => { res.json(summarise(loadConfig())); });
    module.exports = app;
  `);

  const built = await buildInputMap(dir);
  expect(built.error).toBeUndefined();
  map = built.map!;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const symbols = (): string[] => (map.apiInvocations ?? []).map((i) => `${i.package}.${i.symbol}`);

describe('a call written one hop from an entry file', () => {
  it('is recorded', async () => {
    expect(symbols()).toContain('json5.parse');
  });

  it('is attributed to the file that makes it, not to the file that reached it', async () => {
    const parse = (map.apiInvocations ?? []).find((i) => i.package === 'json5' && i.api === 'parse')!;

    // The site is the auditable half of the record. Pointing at server.js — where the call is not
    // written — would make it uncheckable by hand and wrong in the one way nobody would think to check.
    expect(parse.sites.every((s) => s.file === 'src/config.js')).toBe(true);
    expect(parse.sites[0].line).toBeGreaterThan(0);
  });

  it('reports how many local modules it parsed, apart from the entry files', async () => {
    const c = map.coverage as Record<string, number>;

    // config.js is a hop, not an entry: it is already counted under filesPreFiltered, so adding it to
    // filesParsed would double-count it and overstate how much of the app was analysed for endpoints.
    expect(c.filesHopParsed).toBeGreaterThanOrEqual(1);
    expect(c.filesParsed).toBe(1);
  });
});

describe('the hop stops where it says it stops', () => {
  it('does not follow a second hop', async () => {
    // `lodash.pick` is called in deep.js, which only config.js imports. Recording it would mean the
    // bound had silently become "every file the app can reach", which is a different cost profile and a
    // different decision than the one this shipped under.
    expect(symbols()).not.toContain('lodash.pick');
  });

  it('says so in the limitations, in the same terms', async () => {
    const limits = (map.coverage.apiInventoryLimitations ?? []).join(' ');

    // The list is the map's only statement of what its silence means. If the depth changes and this
    // sentence does not, a consumer reads the old bound and draws a conclusion the map cannot support.
    expect(limits).toMatch(/local modules they import directly/);
    expect(limits).toMatch(/two hops away is unseen/);
  });

  it('counts the hop file’s calls in the same buckets, so the totals still add up', async () => {
    const c = map.coverage as Record<string, number>;

    expect(c.callsDependency + c.callsLocal + c.callsAmbiguous).toBe(c.callsTotal);
    // `JSON5.parse` and `readFileSync` are both in config.js; if the hop's calls were collected into the
    // inventory but not into the counts, resolver quality would be measured over the wrong population.
    expect(c.callsDependency).toBeGreaterThanOrEqual(3);
  });
});
