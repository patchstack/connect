import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

/**
 * Header, cookie and upload inputs get a coordinate.
 *
 * `InputSource` declared `header`, `cookie` and `file`; `ADDRESS_SPACES` declared `server`, `cookie` and
 * `files`; and the coordinate mapping for all three was already written. Only extraction never produced
 * them — `REQ_SOURCES` was `['body', 'query', 'params']` — so a header-, cookie- or upload-borne
 * vulnerability could never get a coordinate and therefore never a pinned rule.
 *
 * A declared capability nothing can reach is worse than an absent one, because it reads as covered.
 */
async function endpointFrom(handler: string, extraDeps: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-src-'));
  try {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { express: '4.18.0', pg: '8.0.0', ...extraDeps } }),
    );
    writeFileSync(path.join(dir, 'src/server.ts'), handler);
    const { map } = await buildInputMap(dir, {});

    return map?.endpoints?.[0];
  } finally {
    // Awaited above, so the fixture is still on disk while it is read. An earlier version returned the
    // promise and deleted the directory from a `setTimeout`, which raced the build — the first test read
    // an empty map and reported a defect in code that was correct.
    rmSync(dir, { recursive: true, force: true });
  }
}

const coordinateFor = (endpoint: any, name: string) =>
  endpoint?.inputs?.find((i: any) => i.name === name)?.runtimeParameter;

const sourceFor = (endpoint: any, name: string) =>
  endpoint?.inputs?.find((i: any) => i.name === name)?.source;

describe('a header read', () => {
  it('is addressed as server.HTTP_*, read by element access', async () => {
    // The form a header read almost always takes: the name carries dashes, so it cannot be a property.
    const endpoint = await endpointFrom(
      "import express from 'express';\nconst app = express();\napp.post('/i', (req, res) => {\n  res.end(req.headers['x-api-key']);\n});\n",
    );

    expect(sourceFor(endpoint, 'x-api-key')).toBe('header');
    expect(coordinateFor(endpoint, 'x-api-key')).toBe('server.HTTP_X_API_KEY');
  });

  it('is found through property access too', async () => {
    const endpoint = await endpointFrom(
      "import express from 'express';\nconst app = express();\napp.post('/i', (req, res) => {\n  res.end(req.headers.authorization);\n});\n",
    );

    expect(coordinateFor(endpoint, 'authorization')).toBe('server.HTTP_AUTHORIZATION');
  });

  it('is found through the fetch-style getter', async () => {
    const endpoint = await endpointFrom(
      "export async function POST(request: Request) {\n  const t = request.headers.get('x-token');\n  return new Response(t);\n}\n",
    );

    expect(coordinateFor(endpoint, 'x-token')).toBe('server.HTTP_X_TOKEN');
  });

  it('is not invented from a dynamic key', async () => {
    // `headers[name]` names no field. Emitting one would pin a rule to a parameter that may not exist,
    // and a rule pinned to the wrong parameter never fires while reporting as protection.
    const endpoint = await endpointFrom(
      "import express from 'express';\nconst app = express();\napp.post('/i', (req, res) => {\n  const name = String(req.query.h);\n  res.end(req.headers[name]);\n});\n",
    );

    const headerInputs = (endpoint?.inputs ?? []).filter((i: any) => i.source === 'header');
    expect(headerInputs).toEqual([]);
  });
});

describe('a cookie read', () => {
  it('is addressed as cookie.<name>', async () => {
    const endpoint = await endpointFrom(
      "import express from 'express';\nconst app = express();\napp.post('/i', (req, res) => {\n  res.end(req.cookies.session);\n});\n",
    );

    expect(sourceFor(endpoint, 'session')).toBe('cookie');
    expect(coordinateFor(endpoint, 'session')).toBe('cookie.session');
  });

  it('is found through a destructured namespace', async () => {
    const endpoint = await endpointFrom(
      "import express from 'express';\nconst app = express();\napp.post('/i', ({ cookies }, res) => {\n  res.end(cookies.sid);\n});\n",
    );

    expect(coordinateFor(endpoint, 'sid')).toBe('cookie.sid');
  });
});

describe('an upload read', () => {
  it('is addressed as files.<field>', async () => {
    const endpoint = await endpointFrom(
      "import express from 'express';\nconst app = express();\napp.post('/i', (req, res) => {\n  res.end(String(req.files.avatar));\n});\n",
    );

    expect(sourceFor(endpoint, 'avatar')).toBe('file');
    expect(coordinateFor(endpoint, 'avatar')).toBe('files.avatar');
  });
});

describe('the spaces stay apart', () => {
  it('does not let a header lend its evidence to a body field of the same name', async () => {
    // With no address space a read matches any input sharing the name, so a header read could pin a rule
    // to `post.token`. The two must stay distinguishable.
    const endpoint = await endpointFrom(
      "import express from 'express';\nconst app = express();\napp.post('/i', (req, res) => {\n  res.end(req.headers['token'] + String(req.body.token));\n});\n",
    );

    const coords = (endpoint?.inputs ?? []).filter((i: any) => i.name === 'token').map((i: any) => i.runtimeParameter).sort();
    expect(coords).toEqual(['post.token', 'server.HTTP_TOKEN']);
  });

  // Every namespace that can be destructured needs its own space. `cookies` and `files` were each
  // invisible to the suite until this ran over all three: the header case alone left two entries that no
  // test could distinguish, which is the same as not having tested them.
  const namespaces = [
    { namespace: 'headers', expected: 'server:token' },
    { namespace: 'cookies', expected: 'cookie:token' },
    { namespace: 'files', expected: 'files:token' },
  ];

  for (const { namespace, expected } of namespaces) {
    it(`pins a flow from a destructured ${namespace} read to ${expected}, not to a body field of the same name`, async () => {
      // `Flow.inputId` is `<space>:<path>`, and it is what a rule gets pinned to. A read off a destructured
      // `({ headers })` carried no space, and a flow with no space matches any input sharing the name — so
      // this flow could be attributed to `post:token` and the compiled rule would guard the wrong parameter.
      // Asserting on inputs alone cannot see this: both inputs exist either way, only the flow is misdirected.
      const endpoint = await endpointFrom(
        `import express from 'express';\nimport { Client } from 'pg';\nconst app = express();\nconst db = new Client();\napp.post('/i', ({ ${namespace}, body }, res) => {\n  const t = ${namespace}['token'];\n  db.query('SELECT * FROM t WHERE a = ' + String(t));\n  res.end(String(body.token));\n});\n`,
      );

      // The body field also produces a flow into the query, at the name-matching `heuristic` tier with
      // `ruleGeneratable: false` — that is the map reporting a possibility it cannot prove, which is correct.
      // The invariant is narrower and is the one that matters: the flow a rule can actually be compiled from
      // addresses the right space. Asserting over every flow into the sink would fail on honest heuristic output.
      const intoQuery = (endpoint?.flows ?? []).filter((f: any) => f.sink?.kind === 'db');
      const compilable = intoQuery.filter((f: any) => f.ruleGeneratable === true);
      expect(compilable.length).toBeGreaterThan(0);
      expect([...new Set(compilable.map((f: any) => f.inputId))]).toEqual([expected]);
      // And the body field must not be silently upgraded into that set.
      expect(intoQuery.find((f: any) => f.inputId === 'post:token')?.ruleGeneratable).toBe(false);
    });
  }

  it('still reads body and query as before — the control', async () => {
    const endpoint = await endpointFrom(
      "import express from 'express';\nconst app = express();\napp.post('/i', (req, res) => {\n  res.end(String(req.body.sql) + String(req.query.page));\n});\n",
    );

    expect(coordinateFor(endpoint, 'sql')).toBe('post.sql');
    expect(coordinateFor(endpoint, 'page')).toBe('get.page');
  });
});
