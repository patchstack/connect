import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

/**
 * Common ways a handler reads its request: through the URL's query string, through another name for the
 * request or one of its namespaces, through a framework's event or context object, and through a schema
 * declared outside the handler. Each must name the field it reads, in the namespace it arrives in.
 */
async function mapOf(files: Record<string, string>, deps: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-idioms-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps }));
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      writeFileSync(path.join(dir, file), source);
    }
    const { map } = await buildInputMap(dir, {});

    return map!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EXEC = "import { exec } from 'node:child_process';\n";
const NEXT = { next: '15.0.0' };
const inputs = (endpoint: any): string[] => endpoint.inputs.map((i: any) => `${i.source}:${i.name}`).sort();
const flow = (endpoint: any, name: string) => endpoint.flows.find((f: any) => f.input === name);

const routeHandler = async (body: string, head = '') => {
  const map = await mapOf({ 'app/api/run/route.ts': `${EXEC}${head}export async function GET(request: Request) {\n${body}\n  return new Response('ok');\n}\n` }, NEXT);
  return map.endpoints[0]!;
};
const expressHandler = async (body: string) => {
  const map = await mapOf({ 'src/server.ts': `${EXEC}import express from 'express';\nconst app = express();\napp.post('/run', (req, res) => {\n${body}\n  res.end();\n});\n` }, { express: '4' });
  return map.endpoints[0]!;
};

describe('the query string through a URL of the request', () => {
  it.each([
    ['read in place', "  exec(new URL(request.url).searchParams.get('q'));"],
    ['from a URL binding', "  const url = new URL(request.url);\n  exec(url.searchParams.get('q'));"],
    ['from destructured searchParams', "  const { searchParams } = new URL(request.url);\n  exec(searchParams.get('q'));"],
    ['from a searchParams binding', "  const params = new URL(request.url).searchParams;\n  exec(params.get('q'));"],
  ])('names the query field when %s', async (_label, body) => {
    const endpoint = await routeHandler(body);

    expect(inputs(endpoint)).toEqual(['query:q']);
    expect(flow(endpoint, 'q')).toMatchObject({ confidence: 'exact-local', ruleGeneratable: true });
  });

  it("reads Next.js's nextUrl", async () => {
    const endpoint = await routeHandler("  exec(request.nextUrl.searchParams.get('q'));", "import type { NextRequest } from 'next/server';\n");

    expect(inputs(endpoint)).toEqual(['query:q']);
    expect(flow(endpoint, 'q')?.confidence).toBe('exact-local');
  });

  it("reads a request event's url", async () => {
    const map = await mapOf({ 'src/routes/api/run/+server.ts': `${EXEC}export async function GET({ url }) {\n  exec(url.searchParams.get('q'));\n  return new Response('ok');\n}\n` }, { '@sveltejs/kit': '2' });

    expect(inputs(map.endpoints[0])).toEqual(['query:q']);
    expect(flow(map.endpoints[0], 'q')?.confidence).toBe('exact-local');
  });

  it('does not read a URL built from something other than the request', async () => {
    const endpoint = await routeHandler("  exec(new URL(process.env.TARGET!).searchParams.get('q'));");

    expect(inputs(endpoint)).toEqual([]);
  });

  it('does not treat other members of the request URL as request fields', async () => {
    const endpoint = await routeHandler("  const { href } = await request.json();\n  const url = new URL(request.url);\n  console.log(href);\n  exec(url.href);");

    expect(flow(endpoint, 'href')?.confidence).toBe('heuristic');
  });
});

describe('another name for the request or one of its namespaces', () => {
  it('follows an alias of the request', async () => {
    const endpoint = await expressHandler('  const r = req;\n  exec(r.body.cmd);');

    expect(inputs(endpoint)).toEqual(['body:cmd']);
    expect(flow(endpoint, 'cmd')?.confidence).toBe('exact-local');
  });

  it('follows an alias of the body', async () => {
    const endpoint = await expressHandler('  const b = req.body;\n  exec(b.cmd);');

    expect(inputs(endpoint)).toEqual(['body:cmd']);
    expect(flow(endpoint, 'cmd')?.confidence).toBe('exact-local');
  });

  it('keeps the namespace of an aliased query object', async () => {
    const endpoint = await expressHandler('  const q = req.query;\n  exec(q.id);');

    expect(inputs(endpoint)).toEqual(['query:id']);
    expect(flow(endpoint, 'id')?.confidence).toBe('exact-local');
  });

  it('proves a field destructured from the body', async () => {
    const endpoint = await expressHandler('  const { cmd } = req.body;\n  exec(cmd);');

    expect(flow(endpoint, 'cmd')?.confidence).toBe('exact-local');
  });

  it('reads a header through an alias of the headers', async () => {
    const endpoint = await routeHandler("  const headers = request.headers;\n  exec(headers.get('x-cmd'));");

    expect(inputs(endpoint)).toEqual(['header:x-cmd']);
    expect(flow(endpoint, 'x-cmd')?.confidence).toBe('exact-local');
  });

  it('does not treat an alias of the body as the request itself', async () => {
    const endpoint = await expressHandler("  const b = req.body;\n  console.log(req.headers['x-cmd']);\n  exec(b.headers.get('x-cmd'));");

    expect(inputs(endpoint)).toContain('header:x-cmd');
    expect(flow(endpoint, 'x-cmd')?.confidence).toBe('heuristic');
  });

  it('does not read a parsed body field named after a namespace as that namespace', async () => {
    const endpoint = await expressHandler("  const b = req.body;\n  const { query } = b;\n  exec(query.id);");

    expect(inputs(endpoint)).not.toContain('query:id');
  });
});

describe('framework request objects', () => {
  it("reads the request from a request event's `request`", async () => {
    const map = await mapOf({ 'src/routes/api/run/+server.ts': `${EXEC}export async function POST({ request }) {\n  exec(request.headers.get('x-cmd'));\n  return new Response('ok');\n}\n` }, { '@sveltejs/kit': '2' });

    expect(inputs(map.endpoints[0])).toEqual(['header:x-cmd']);
    expect(flow(map.endpoints[0], 'x-cmd')?.confidence).toBe('exact-local');
  });

  it("reads route params from Next.js's route context", async () => {
    const map = await mapOf({ 'app/api/run/[id]/route.ts': `${EXEC}export async function GET(request: Request, { params }: { params: { id: string } }) {\n  exec(params.id);\n  return new Response('ok');\n}\n` }, NEXT);

    expect(inputs(map.endpoints[0])).toEqual(['route-param:id']);
  });

  it('reads the Hono request accessors', async () => {
    const map = await mapOf({
      'src/index.ts': `${EXEC}import { Hono } from 'hono';\nconst app = new Hono();\napp.post('/run', async (c) => {\n  const body = await c.req.json();\n  exec(body.cmd);\n  exec(c.req.query('q'));\n  exec(c.req.param('id'));\n  exec(c.req.header('x-cmd'));\n  return c.text('ok');\n});\n`,
    }, { hono: '4' });
    const endpoint = map.endpoints[0]!;

    expect(inputs(endpoint)).toEqual(['header:x-cmd', 'json-body:cmd', 'query:q', 'route-param:id']);
    for (const name of ['cmd', 'q', 'id', 'x-cmd']) {
      expect(endpoint.flows.filter((f: any) => f.input === name && f.confidence === 'exact-local')).toHaveLength(1);
    }
  });

  it("does not inventory a Hono query accessor as a database call", async () => {
    const map = await mapOf({
      'src/index.ts': "import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/run', (c) => c.text(c.req.query('q') ?? ''));\n",
    }, { hono: '4' });

    expect(map.endpoints[0]!.sinks).toEqual([]);
  });

  it('still inventories a query call on a request accessor of an imported object', async () => {
    const map = await mapOf({
      'src/server.ts': "import express from 'express';\nimport sdk from 'data-sdk';\nconst app = express();\napp.post('/run', (req, res) => { sdk.req.query(req.body.sql); res.end(); });\n",
    }, { express: '4', 'data-sdk': '1' });

    expect(map.endpoints[0]!.sinks.map((s: any) => s.kind)).toEqual(['db']);
  });

  it('still inventories a query call on a client', async () => {
    const map = await mapOf({
      'src/server.ts': "import express from 'express';\nimport { Pool } from 'pg';\nconst pool = new Pool();\nconst app = express();\napp.post('/run', (req, res) => { pool.query(req.body.sql); res.end(); });\n",
    }, { express: '4', pg: '8' });

    expect(map.endpoints[0]!.sinks.map((s: any) => s.kind)).toEqual(['db']);
  });

  it('does not read an accessor call on the request itself as a Hono accessor', async () => {
    const endpoint = await expressHandler("  exec(req.param('id'));");

    expect(inputs(endpoint)).toEqual([]);
  });
});

describe('Next.js Pages Router API routes', () => {
  it.each([
    ['a default-exported function', 'export default function handler(req, res) {\n  exec(req.body.cmd);\n  res.end();\n}\n'],
    ['a named handler exported as default', 'const handler = (req, res) => {\n  exec(req.body.cmd);\n  res.end();\n};\nexport default handler;\n'],
    ['a default-exported arrow', 'export default async (req, res) => {\n  exec(req.body.cmd);\n  res.end();\n};\n'],
  ])('maps %s under pages/api to its route', async (_label, source) => {
    const map = await mapOf({ 'pages/api/run.ts': EXEC + source }, NEXT);

    expect(map.endpoints).toHaveLength(1);
    expect(map.endpoints[0]).toMatchObject({ entryKind: 'route-handler', route: '/api/run' });
    expect(flow(map.endpoints[0], 'cmd')?.confidence).toBe('exact-local');
  });

  it('does not map the default export of a page', async () => {
    const map = await mapOf({ 'pages/about.tsx': 'export default function About() { return null; }\n' }, NEXT);

    expect(map.endpoints).toEqual([]);
  });
});

describe('a schema declared outside the handler', () => {
  it('reads the fields of a schema declared in the same module', async () => {
    const endpoint = await routeHandler('  const data = Schema.parse(await request.json());\n  exec(data.cmd);', "import { z } from 'zod';\nconst Schema = z.object({ cmd: z.string() });\n");

    expect(inputs(endpoint)).toEqual(['json-body:cmd']);
    expect(flow(endpoint, 'cmd')?.confidence).toBe('exact-local');
    expect(endpoint.inputsResolved).toBeUndefined();
  });

  it('reads a schema applied to a local that holds the body', async () => {
    const endpoint = await routeHandler('  const raw = await request.json();\n  const data = Schema.parse(raw);\n  exec(data.cmd);', "import { z } from 'zod';\nconst Schema = z.object({ cmd: z.string() });\n");

    expect(inputs(endpoint)).toEqual(['json-body:cmd']);
  });

  it('reports the inputs of a handler validated by an imported schema as unresolved', async () => {
    const endpoint = await routeHandler('  const data = Schema.parse(await request.json());\n  exec(data.cmd);', "import { Schema } from '../../../lib/schema';\n");

    expect(endpoint.inputsResolved).toBe(false);
  });

  it('does not read JSON.parse as a schema', async () => {
    const endpoint = await routeHandler('  const data = JSON.parse(await request.text());\n  exec(data.cmd);');

    expect(endpoint.inputsResolved).toBeUndefined();
  });

  it('does not read a schema applied to something other than the request', async () => {
    const endpoint = await routeHandler('  const data = Schema.parse(defaults);\n  exec(data.cmd);', "import { Schema } from '../../../lib/schema';\nconst defaults = {};\n");

    expect(endpoint.inputsResolved).toBeUndefined();
  });
});
