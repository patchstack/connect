import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

/**
 * A method called on request data is a call on a value, not a field named after the method.
 *
 * `request.headers.get('x-cmd')` reads the header `x-cmd`: the input is `x-cmd`, and what reaches a
 * sink is exactly that value. `get` is not a header, and a coordinate built from it would name a
 * parameter no request carries — a rule pinned there never fires while reading as protection.
 */
async function endpointFrom(file: string, source: string, deps: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-method-'));
  try {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps }));
    writeFileSync(path.join(dir, file), source);
    const { map } = await buildInputMap(dir, {});

    return map?.endpoints?.[0];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const inputNames = (endpoint: any): string[] => (endpoint?.inputs ?? []).map((i: any) => i.name).sort();
const flowFor = (endpoint: any, name: string) => (endpoint?.flows ?? []).find((f: any) => f.input === name);

const NEXT = { next: '15.0.0' };
const route = 'app/api/run/route.ts';

describe('an accessor call on a request namespace', () => {
  it('reads the named header, and no field named after the method', async () => {
    const endpoint = await endpointFrom(
      route,
      "import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n  exec(request.headers.get('x-cmd'));\n  return new Response('ok');\n}\n",
      NEXT,
    );

    expect(inputNames(endpoint)).toEqual(['x-cmd']);
    expect(flowFor(endpoint, 'x-cmd')).toMatchObject({ confidence: 'exact-local', ruleGeneratable: true });
  });

  it('reads the named cookie the same way', async () => {
    const endpoint = await endpointFrom(
      route,
      "import { exec } from 'node:child_process';\nimport type { NextRequest } from 'next/server';\nexport async function POST(request: NextRequest) {\n  exec(request.cookies.get('sid'));\n  return new Response('ok');\n}\n",
      NEXT,
    );

    expect(inputNames(endpoint)).toEqual(['sid']);
    expect(flowFor(endpoint, 'sid')).toMatchObject({ confidence: 'exact-local' });
  });

  it('reads the named field of a form body', async () => {
    const endpoint = await endpointFrom(
      route,
      "import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n  const form = await request.formData();\n  exec(form.get('cmd'));\n  return new Response('ok');\n}\n",
      NEXT,
    );

    expect(inputNames(endpoint)).toEqual(['cmd']);
    expect(flowFor(endpoint, 'cmd')).toMatchObject({ confidence: 'exact-local', ruleGeneratable: true });
  });

  it('holds when the value is read into a variable first', async () => {
    const endpoint = await endpointFrom(
      route,
      "import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n  const cmd = request.headers.get('x-cmd');\n  exec(cmd);\n  return new Response('ok');\n}\n",
      NEXT,
    );

    expect(inputNames(endpoint)).toEqual(['x-cmd']);
    expect(flowFor(endpoint, 'get')).toBeUndefined();
    expect(flowFor(endpoint, 'x-cmd')).toMatchObject({ confidence: 'exact-local', ruleGeneratable: true });
  });

  it('lends no evidence to an input when the name read is a variable', async () => {
    // `x` is a real header, read by name, and also the name of a local holding some other name. The
    // second read is of an unknown header, so it proves nothing about `x`.
    const endpoint = await endpointFrom(
      route,
      "import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n  const seen = request.headers.get('x');\n  const x = 'x-' + Math.random();\n  exec(request.headers.get(x));\n  return new Response(seen);\n}\n",
      NEXT,
    );

    expect(flowFor(endpoint, 'x')).toMatchObject({ ruleGeneratable: false });
    expect(flowFor(endpoint, 'x')?.confidence).not.toBe('exact-local');
  });

  it('invents nothing when the name is not a literal', async () => {
    const endpoint = await endpointFrom(
      route,
      "import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n  const which = 'x-' + Math.random();\n  exec(request.headers.get(which));\n  return new Response('ok');\n}\n",
      NEXT,
    );

    expect(inputNames(endpoint)).toEqual([]);
  });
});

describe('a .get() that is not a request accessor', () => {
  const express = (line: string) =>
    endpointFrom(
      'src/server.ts',
      `import express from 'express';\nimport { exec } from 'node:child_process';\nconst app = express();\napp.post('/r', (req, res) => {\n  ${line}\n  res.end();\n});\n`,
      { express: '4.18.0' },
    );

  it('on a nested body value is an application method, and no exact read', async () => {
    const endpoint = await express("exec(req.body.account.get('name'));");

    expect(inputNames(endpoint)).toEqual(['account']);
    expect(flowFor(endpoint, 'account')?.confidence).not.toBe('exact-local');
    expect(flowFor(endpoint, 'name')).toBeUndefined();
  });

  it('on the body itself names no input', async () => {
    const endpoint = await express("exec(req.body.get('name'));");

    expect(inputNames(endpoint)).not.toContain('name');
    expect((endpoint?.flows ?? []).filter((f: any) => f.confidence === 'exact-local')).toEqual([]);
  });

  it('on the query object names no input', async () => {
    const endpoint = await express("exec(req.query.get('name'));");

    expect(inputNames(endpoint)).not.toContain('name');
    expect((endpoint?.flows ?? []).filter((f: any) => f.confidence === 'exact-local')).toEqual([]);
  });

  it('on a json() body is an application method too', async () => {
    const endpoint = await endpointFrom(
      route,
      "import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n  const body = await request.json();\n  exec(body.get('cmd'));\n  return new Response('ok');\n}\n",
      NEXT,
    );

    expect((endpoint?.flows ?? []).filter((f: any) => f.confidence === 'exact-local')).toEqual([]);
  });
});

describe('evidence a non-accessor .get() must not lend', () => {
  it('to a json() field of the same name', async () => {
    // `cmd` is a real body input, read directly elsewhere; `body.get('cmd')` is an application method on
    // the parsed object and proves nothing about what reaches the sink.
    const endpoint = await endpointFrom(
      route,
      "import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n  const body = await request.json();\n  console.log(body.cmd);\n  exec(body.get('cmd'));\n  return new Response('ok');\n}\n",
      NEXT,
    );

    expect(inputNames(endpoint)).toContain('cmd');
    expect(flowFor(endpoint, 'cmd')?.confidence).not.toBe('exact-local');
  });

  it('to a body field that happens to carry a headers member', async () => {
    const endpoint = await endpointFrom(
      'src/server.ts',
      "import express from 'express';\nimport { exec } from 'node:child_process';\nconst app = express();\napp.post('/r', (req, res) => {\n  const user = req.body.user;\n  exec(user.headers.get('x'));\n  res.end();\n});\n",
      { express: '4.18.0' },
    );

    expect(flowFor(endpoint, 'user')?.confidence).not.toBe('exact-local');
  });
});

describe('namespace names on something other than the request', () => {
  it('do not make a parsed body an accessor of real headers', async () => {
    // `x-token` is a real header, read directly. `body.headers.get('x-token')` is a method on the parsed
    // JSON body and proves nothing about it.
    const endpoint = await endpointFrom(
      route,
      "import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n  const token = request.headers.get('x-token');\n  const body = await request.json();\n  exec(body.headers.get('x-token'));\n  return new Response(token);\n}\n",
      NEXT,
    );

    expect(inputNames(endpoint)).toContain('x-token');
    expect(flowFor(endpoint, 'x-token')).toMatchObject({ ruleGeneratable: false });
    expect(flowFor(endpoint, 'x-token')?.confidence).not.toBe('exact-local');
  });

  it('do not move a body field into another address space', async () => {
    // `id` is a real query parameter; `body.query.id` is a field of the body that happens to be called
    // `query`. Only on the request itself is `query` the query string.
    const endpoint = await endpointFrom(
      'src/server.ts',
      "import express from 'express';\nimport { exec } from 'node:child_process';\nconst app = express();\napp.post('/r', ({ body, query }, res) => {\n  console.log(query.id);\n  exec(body.query.id);\n  res.end();\n});\n",
      { express: '4.18.0' },
    );

    const queryId = endpoint?.inputs?.find((i: any) => i.name === 'id' && i.source === 'query');
    expect(queryId).toBeDefined();
    expect((endpoint?.flows ?? []).find((f: any) => f.inputId === queryId.id)?.confidence).not.toBe('exact-local');
  });

  it('do not read a header through a body field called headers', async () => {
    const endpoint = await endpointFrom(
      route,
      "import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n  const token = request.headers.get('x-token');\n  const body = await request.json();\n  exec(body.headers['x-token']);\n  return new Response(token);\n}\n",
      NEXT,
    );

    expect(flowFor(endpoint, 'x-token')?.confidence).not.toBe('exact-local');
  });

  it('do not turn a method on a body field into an exact read of it', async () => {
    // `headers` is a real body field here, so `body.headers.get('x')` is a transformation of it — not a
    // read of a field inside it.
    const endpoint = await endpointFrom(
      route,
      "import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n  const body = await request.json();\n  console.log(body.headers);\n  exec(body.headers.get('x'));\n  return new Response('ok');\n}\n",
      NEXT,
    );

    expect(flowFor(endpoint, 'headers')).toBeDefined();
    expect(flowFor(endpoint, 'headers')?.confidence).not.toBe('exact-local');
  });

  it('do not make the response object a request', async () => {
    const endpoint = await endpointFrom(
      'src/server.ts',
      "import express from 'express';\nimport { exec } from 'node:child_process';\nconst app = express();\napp.post('/r', (req, res) => {\n  console.log(req.body.cmd);\n  exec(res.body.cmd);\n  res.end();\n});\n",
      { express: '4.18.0' },
    );

    expect(flowFor(endpoint, 'cmd')?.confidence).not.toBe('exact-local');
  });
});

describe('destructuring namespace names', () => {
  const route_ = (lines: string) =>
    endpointFrom(
      route,
      `import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n  const b = await request.json();\n  console.log(b.cmd);\n  ${lines}\n  return new Response('ok');\n}\n`,
      NEXT,
    );

  it('off a parsed body gives no accessor', async () => {
    // `cmd` is a real body field read elsewhere; `headers` here is another body field, and `.get()` on it
    // proves nothing about `cmd`.
    const endpoint = await route_("const { headers } = await request.json();\n  exec(headers.get('cmd'));");

    expect(flowFor(endpoint, 'cmd')?.confidence).not.toBe('exact-local');
    expect(flowFor(endpoint, 'cmd')?.ruleGeneratable).toBe(false);
  });

  it('off a parsed body gives no namespace', async () => {
    const endpoint = await route_("const { query } = await request.json();\n  exec(query.cmd);");

    expect(flowFor(endpoint, 'cmd')?.confidence).not.toBe('exact-local');
  });

  it('off the request itself still gives the namespace', async () => {
    const endpoint = await route_("const { headers } = request;\n  exec(headers.get('x-cmd'));");

    expect(flowFor(endpoint, 'x-cmd')).toMatchObject({ confidence: 'exact-local' });
  });
});

describe('a destructured accessor', () => {
  it('reads the named cookie from a destructured cookie store', async () => {
    const endpoint = await endpointFrom(
      'src/routes/run/+server.ts',
      "import { exec } from 'node:child_process';\nexport async function POST({ cookies }) {\n  exec(cookies.get('sid'));\n  return new Response('ok');\n}\n",
      { '@sveltejs/kit': '2.0.0' },
    );

    expect(inputNames(endpoint)).toEqual(['sid']);
    expect(flowFor(endpoint, 'sid')).toMatchObject({ confidence: 'exact-local' });
  });
});

describe('a method called on a request field', () => {
  it('is a transformation of that field, not a field of its own', async () => {
    const endpoint = await endpointFrom(
      'src/server.ts',
      "import express from 'express';\nimport { exec } from 'node:child_process';\nconst app = express();\napp.post('/run', (req, res) => {\n  exec(req.body.cmd.trim());\n  res.end();\n});\n",
      { express: '4.18.0' },
    );

    expect(inputNames(endpoint)).toEqual(['cmd']);
    expect(flowFor(endpoint, 'cmd')).toMatchObject({ confidence: 'transformed-local' });
  });

  it('is a transformation even when it takes a single literal, like an accessor does', async () => {
    const endpoint = await endpointFrom(
      'src/server.ts',
      "import express from 'express';\nimport { exec } from 'node:child_process';\nconst app = express();\napp.post('/run', (req, res) => {\n  exec(req.body.cmd.concat(' --dry-run'));\n  res.end();\n});\n",
      { express: '4.18.0' },
    );

    expect(flowFor(endpoint, 'cmd')).toMatchObject({ confidence: 'transformed-local' });
  });
});
