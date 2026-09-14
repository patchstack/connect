import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ps-dependency-flows-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: { express: '4', '@example/reader': '1', 'doc-kit': '1', axios: '1', 'static-middleware': '1' },
  }));
  writeFileSync(join(dir, 'src', 'server.ts'), `
    import express from 'express';
    import reader from '@example/reader';
    import { parse as parseDoc } from 'doc-kit/subpath';
    import axios from 'axios';
    import serveStatic from 'static-middleware';
    const app = express();
    const client = reader.create();

    app.post('/direct', async (req, res) => {
      const host = req.body.host;
      reader.scan(host);
      parseDoc(req.query.source);
      client.inspect({ value: req.body.value });
      axios.get(req.body.url);
      res.end();
    });

    app.post('/lookalike', (req, res) => {
      const local = { inspect() {} };
      local.inspect(req.body.fake);
      reader.inspect({ host: 'fixed', other: req.body.other });
      reader.schedule(() => req.body.later);
      function uncalled() { reader.scan(req.body.uncalled); }
      res.end();
    });

    app.post('/namespaces', (req, res) => {
      reader.scan(req.query.id);
      res.json(req.body.id);
    });

    app.use(serveStatic({ path: './public' }));
  `);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('request input reaching a dependency API', () => {
  it('records the package API, argument position, and request-field identity without calling it a sink', async () => {
    const { map } = await buildInputMap(dir);
    const endpoint = map!.endpoints.find((e) => e.route === '/direct')!;
    const links = endpoint.dependencyInputFlows ?? [];

    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ package: '@example/reader', api: 'scan', input: 'host', argumentIndex: 0, argumentUse: 'direct' }),
      expect.objectContaining({ package: 'doc-kit', specifier: 'doc-kit/subpath', api: 'parse', input: 'source', argumentIndex: 0 }),
      expect.objectContaining({ package: '@example/reader', api: 'inspect', resolution: 'factory', input: 'value', argumentUse: 'within-expression' }),
    ]));
    expect(links.every((link) => endpoint.inputs.some((input) => input.id === link.inputId))).toBe(true);
    expect(endpoint.sinks.some((sink) => sink.package === '@example/reader')).toBe(false);
    expect(links.some((link) => link.package === 'axios')).toBe(false);
  });

  it('does not infer a dependency call from a local lookalike, a property key, or uncalled code', async () => {
    const { map } = await buildInputMap(dir);
    const endpoint = map!.endpoints.find((e) => e.route === '/lookalike')!;
    const links = endpoint.dependencyInputFlows ?? [];

    expect(links.some((link) => ['fake', 'host', 'later', 'uncalled'].includes(link.input))).toBe(false);
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ package: '@example/reader', api: 'inspect', input: 'other' }),
    ]));
  });

  it('does not invent a request-input link for static middleware setup', async () => {
    const { map } = await buildInputMap(dir);
    expect(map!.apiInvocations?.some((invocation) => invocation.package === 'static-middleware')).toBe(true);
    expect(map!.endpoints.flatMap((endpoint) => endpoint.dependencyInputFlows ?? [])
      .some((link) => link.package === 'static-middleware')).toBe(false);
  });

  it('keeps equal field names in different request spaces separate', async () => {
    const { map } = await buildInputMap(dir);
    const endpoint = map!.endpoints.find((e) => e.route === '/namespaces')!;
    const links = endpoint.dependencyInputFlows ?? [];

    expect(links).toEqual([expect.objectContaining({ inputId: 'get:id', api: 'scan' })]);
    expect(links.some((link) => link.inputId === 'post:id')).toBe(false);
  });

  it('marks a bounded endpoint instead of silently claiming complete coverage', async () => {
    const file = join(dir, 'src', 'many.ts');
    writeFileSync(file, `
      import reader from '@example/reader';
      export function POST(req) {
        ${Array.from({ length: 105 }, () => 'reader.scan(req.body.host);').join('\n')}
      }
    `);
    try {
      const { map } = await buildInputMap(dir);
      const endpoint = map!.endpoints.find((e) => e.file === join('src', 'many.ts'))!;
      expect(endpoint.dependencyInputFlows).toHaveLength(100);
      expect(endpoint.dependencyInputFlowsTruncated).toBe(true);
    } finally {
      rmSync(file);
    }
  });
});
