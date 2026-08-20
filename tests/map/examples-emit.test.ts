import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

// Regeneration entry point for the DEMO maps a platform loads to show what each server-surface state looks
// like on a dashboard.
//
// Same reasoning as `ladder-emit`, for a different consumer. These documents became product examples the
// moment someone looked at a dashboard through them, and a hand-written example is worse than no example: it
// shows a shape the extractor does not actually emit, and it goes stale silently — a map older than this
// extractor still parses and still renders, it just answers for an app the extractor now reads differently.
// Generating them from real little apps keeps the demo honest and the provenance reproducible.
//
// The states the extractor never emits — a build with no `serverSurface` (older than the check) and one
// reporting a state the reader does not know (newer than it) — are deliberately NOT emitted here. They are
// derived by the loader from `server-runtime.json`, because they are properties of the consumer's timeline
// rather than of any app: there is no source tree that produces them.
//
// Run:
//   PS_EXAMPLE_EMIT_DIR=/path/to/examples npx vitest run tests/map/examples-emit
//
// Then inspect the diff before loading anything, exactly as with the ladder fixtures.
//
// Skipped otherwise, so a normal suite run neither writes files nor needs a directory.

const OUT = process.env.PS_EXAMPLE_EMIT_DIR;

/** Per-machine measurements. They carry no contract, and leaving them in makes every regeneration a diff on noise. */
const VOLATILE = ['analysisMs', 'rssBytes', 'peakRssBytes'] as const;

interface ExampleApp {
  /** Output filename, and the state the app is here to produce. */
  id: string;
  expect: 'server-runtime-detected' | 'static-build-detected' | 'unknown';
  /** Why this app produces that state — the thing a reader of the demo needs to know. */
  why: string;
  packageJson: Record<string, unknown>;
  files: Record<string, string>;
}

/**
 * Four apps, one per state worth showing, and the two `unknown` variants are separate on purpose: their
 * evidence differs, so a consumer that derives a next step from the evidence has something to derive from.
 *
 * Dependencies are pinned to versions that well-known public advisories affect, so a platform loading these
 * gets a populated reachability view rather than a map with nothing to join against.
 */
const APPS: ExampleApp[] = [
  {
    id: 'server-runtime',
    expect: 'server-runtime-detected',
    why: 'Express routes the extractor recognises, with request input reaching several dependency sinks.',
    packageJson: {
      name: 'orders-api',
      dependencies: {
        express: '4.18.2',
        axios: '0.21.0',
        sequelize: '4.44.0',
        lodash: '4.17.11',
        'node-serialize': '0.0.4',
        systeminformation: '5.3.0',
      },
    },
    files: {
      'src/server.js': `const express = require('express');
const axios = require('axios');
const app = express();

app.get('/api/preview', async (req, res) => {
  const upstream = await axios.get(req.query.url);
  res.json(upstream.data);
});

app.post('/api/orders', async (req, res) => {
  const { sequelize } = require('./db');
  const rows = await sequelize.query('SELECT * FROM orders WHERE ref = ' + req.body.ref);
  res.json(rows);
});

module.exports = app;
`,
      'src/db.js': `const Sequelize = require('sequelize');
const sequelize = new Sequelize(process.env.DATABASE_URL);
module.exports = { sequelize };
`,
      'src/settings.js': `const express = require('express');
const merge = require('lodash/merge');
const serialize = require('node-serialize');
const si = require('systeminformation');
const router = express.Router();

router.post('/api/settings', (req, res) => {
  const settings = merge({ theme: 'light' }, req.body.settings);
  res.json(settings);
});

router.post('/api/session', (req, res) => {
  const restored = serialize.unserialize(req.cookies.profile);
  res.json(restored);
});

router.get('/api/diagnostics', async (req, res) => {
  const out = await si.inetLatency(req.query.host);
  res.json({ out });
});

module.exports = router;
`,
    },
  },
  {
    id: 'static-build',
    expect: 'static-build-detected',
    why: 'A static generator named in the manifest, nothing that serves, and no deployment artifact to veto the reading.',
    packageJson: {
      name: 'marketing-site',
      devDependencies: { astro: '4.5.0' },
      dependencies: { lodash: '4.17.11' },
    },
    files: {
      'astro.config.mjs': `import { defineConfig } from 'astro/config';
export default defineConfig({ output: 'static' });
`,
      'src/pages/index.astro': `---
import groupBy from 'lodash/groupBy';
const posts = groupBy([], 'year');
---
<h1>Posts</h1>
`,
    },
  },
  {
    id: 'unknown-unparsed-stack',
    expect: 'unknown',
    why: 'A server framework in the manifest with routes registered from a table — no call site the extractor reads. The case that must never render as "no server side".',
    packageJson: {
      name: 'internal-tool',
      dependencies: { fastify: '4.26.0', axios: '0.21.0', lodash: '4.17.11' },
    },
    files: {
      'src/index.js': `const fastify = require('fastify');
const routes = require('./routes');

const app = fastify();
for (const route of routes) app.route(route);

app.listen({ port: 3000 });
`,
      'src/routes.js': `const axios = require('axios');
const pick = require('lodash/pick');

module.exports = [
  { method: 'GET', url: '/health', handler: async () => ({ ok: true }) },
  { method: 'POST', url: '/fetch', handler: async (req) => pick(await axios.get(req.body.url), ['status']) },
];
`,
    },
  },
  {
    id: 'unknown-deployment-declared',
    expect: 'unknown',
    why: 'A platform config AND a named static generator: the config rules out a confident static reading without proving anything serves, so both signals appear and the state stays open.',
    packageJson: {
      name: 'docs-portal',
      devDependencies: { vite: '5.2.0' },
      dependencies: { axios: '0.21.0' },
    },
    files: {
      'netlify.toml': `[build]
  command = "vite build"
  publish = "dist"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/:splat"
  status = 200
`,
      'vite.config.js': `import { defineConfig } from 'vite';
export default defineConfig({ build: { outDir: 'dist' } });
`,
      'src/main.js': `import axios from 'axios';
export const load = (path) => axios.get(path).then((r) => r.data);
`,
    },
  },
];

/** The consumer's on-disk form: two-space JSON with a trailing newline. Byte-identical or it diffs. */
const serialize = (document: unknown): string => JSON.stringify(document, null, 2) + '\n';

async function mapFor(app: ExampleApp): Promise<Record<string, any>> {
  const dir = mkdtempSync(join(tmpdir(), 'ps-example-'));
  try {
    for (const [rel, body] of Object.entries(app.files)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(app.packageJson, null, 2));

    const { map, error } = await buildInputMap(dir);
    expect(error, `${app.id} must produce a map`).toBeUndefined();
    const document = map as Record<string, any>;
    for (const field of VOLATILE) delete document.coverage[field];

    return document;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An index beside the maps, so a loader does not restate which file demonstrates what. */
function manifest(): Record<string, unknown> {
  return {
    note: 'Generated from the demo example apps. Do not edit; regenerate.',
    derivedByConsumer: [
      'not-reported — server-runtime.json with `serverSurface` removed: a build older than the check',
      'unreadable — server-runtime.json with an unrecognised `serverSurface.state`: a build newer than the reader',
    ],
    examples: APPS.map((app) => ({ id: app.id, expect: app.expect, why: app.why })),
  };
}

describe.skipIf(!OUT)('demo example maps', () => {
  it.each(APPS.map((app) => [app.id, app] as const))('emits %s', async (id, app) => {
    const document = await mapFor(app);

    // The app is only useful as an example if it still produces the state it was written for. An extractor
    // change that moves it turns the demo into a map of something else, which is the drift this catches.
    expect(document.serverSurface?.state, `${id} must still produce ${app.expect}`).toBe(app.expect);

    writeFileSync(join(OUT!, `${id}.json`), serialize(document));
  });

  it('emits the index', () => {
    writeFileSync(join(OUT!, 'examples.json'), serialize(manifest()));
  });
});

// Runs in the ordinary suite: the apps must keep producing the states they are here to demonstrate, whether
// or not anyone is regenerating. Without this the emitter is only checked on the days someone runs it.
describe('the demo example apps still demonstrate their states', () => {
  it.each(APPS.map((app) => [app.id, app] as const))('%s', async (id, app) => {
    const document = await mapFor(app);
    expect(document.serverSurface?.state, `${id}: ${app.why}`).toBe(app.expect);
  });
});
