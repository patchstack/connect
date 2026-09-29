import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { routeFromFilePath } from '../../src/map/extract.js';

/**
 * A route in the map is a URL the app serves. A rule scoped to a route the app does not serve never
 * matches, so a call that merely shares a router method's name, or a file whose location is not a URL,
 * must not produce one.
 */
async function endpointsOf(file: string, source: string, deps: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-routes-'));
  try {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps }));
    writeFileSync(path.join(dir, file), source);
    const { map } = await buildInputMap(dir, {});

    return map!.endpoints;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('route registrations', () => {
  it('does not register a route for a method call whose first argument is not a path', async () => {
    const endpoints = await endpointsOf('src/server.ts',
      "import express from 'express';\nconst app = express();\nconst cache = new Map();\ncache.get('user', (req: any) => req.body.x);\napp.get('/users', (req, res) => res.send(req.query.id));\n",
      { express: '4' });

    expect(endpoints.map((e) => e.route)).toEqual(['/users']);
  });

  it('registers a catch-all route', async () => {
    const endpoints = await endpointsOf('src/server.ts',
      "import express from 'express';\nconst app = express();\napp.all('*', (req, res) => res.send(req.query.id));\n",
      { express: '4' });

    expect(endpoints.map((e) => e.route)).toEqual(['*']);
  });

  it('does not register an object-form route whose url is not a path', async () => {
    const endpoints = await endpointsOf('src/server.ts',
      "import Fastify from 'fastify';\nconst app = Fastify();\njobs.route({ method: 'GET', url: 'nightly', handler: async (req) => req.query.id });\napp.route({ method: 'GET', url: '/items', handler: async (req) => req.query.id });\n",
      { fastify: '4' });

    expect(endpoints.map((e) => e.route)).toEqual(['/items']);
  });
});

describe('file-based routes', () => {
  it.each(['src/pages/actions.ts', 'server/api/actions.ts'])('gives a server action in %s no route from its file location', async (file) => {
    const endpoints = await endpointsOf(file,
      "'use server';\nimport { exec } from 'node:child_process';\nexport async function report(input: any) { exec(input.job); }\n",
      { next: '15' });

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({ entryKind: 'server-action' });
    expect(endpoints[0]!.route).toBeUndefined();
  });

  it.each([
    ['server/api/items.post.ts', '/api/items'],
    ['server/api/items/[id].ts', '/api/items/:id'],
    ['server/routes/hello.ts', '/hello'],
    ['server/routes/index.ts', '/'],
  ])('maps the Nuxt server route %s to %s', (file, expected) => {
    expect(routeFromFilePath(file).route).toBe(expected);
  });

  it.each(['server/utils/db.ts', 'server/middleware/auth.ts', 'src/server/handlers.ts'])('gives %s no route', (file) => {
    expect(routeFromFilePath(file).route).toBeUndefined();
  });
});
