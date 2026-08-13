import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInputMap } from '../src/map/index.js';
import { runtimeCoordinate } from '../src/map/extract.js';

// Track 1 — TRUSTED COORDINATES. A server compiling a map input into a rule must be handed the exact
// engine parameter, or nothing at all: a coordinate the resolver cannot resolve compiles into a rule
// that silently never matches, which is worse than emitting none.

describe('runtimeCoordinate mapping', () => {
  it.each([
    ['json-body', 'shipping.email', 'post.shipping.email'],
    ['body', 'path', 'post.path'],
    ['form-body', 'note', 'post.note'],
    ['server-fn-data', 'title', 'post.title'],
    ['query', 'q', 'get.q'],
    ['cookie', 'session', 'cookie.session'],
    ['file', 'avatar', 'files.avatar'],
    ['header', 'x-api-key', 'server.HTTP_X_API_KEY'],
  ] as const)('%s/%s → %s', (source, path, expected) => {
    expect(runtimeCoordinate(source, path).runtimeParameter).toBe(expected);
  });

  it('refuses a coordinate for a route param — the resolver does not expose req.params', () => {
    const r = runtimeCoordinate('route-param', 'tenant');
    expect(r.runtimeParameter).toBeNull();
    expect(r.runtimeParameterReason).toMatch(/route parameters are not exposed/i);
  });

  it('refuses a coordinate for an array path — that needs array_key_value, not a dotted parameter', () => {
    const r = runtimeCoordinate('json-body', 'tags[].label');
    expect(r.runtimeParameter).toBeNull();
    expect(r.runtimeParameterReason).toMatch(/array_key_value/);
  });

  it('refuses a coordinate when the source is unknown', () => {
    expect(runtimeCoordinate(undefined, 'x').runtimeParameter).toBeNull();
  });
});

describe('coordinates on a real project', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ps-coord-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
    writeFileSync(join(dir, 'src', 's.ts'), `
      import express from "express";
      import fs from "node:fs";
      const app = express();
      app.post("/api/:tenant/files", (req, res) => {
        fs.writeFileSync(req.body.path, req.query.data);
        res.end(req.params.tenant);
      });
    `);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('labels each input with its source and the coordinate that addresses it', async () => {
    const { map } = await buildInputMap(dir);
    expect(map!.version).toBe(2);
    const ep = map!.endpoints[0]!;
    const by = Object.fromEntries(ep.inputs.map((i) => [i.name, i]));
    expect(by.path).toMatchObject({ source: 'body', runtimeParameter: 'post.path' });
    expect(by.data).toMatchObject({ source: 'query', runtimeParameter: 'get.data' });
    // The safety case: a route param is reported, but WITHOUT a coordinate.
    expect(by.tenant).toMatchObject({ source: 'route-param', runtimeParameter: null });
    expect(by.tenant.runtimeParameterReason).toBeTruthy();
  });

  it('carries a content fingerprint so a server can reject stale coordinates after a deploy', async () => {
    const { map } = await buildInputMap(dir);
    const ep = map!.endpoints[0]!;
    expect(ep.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof ep.start).toBe('number');
  });

  it('reports ruleGeneratable separately from confidence, with reasons', async () => {
    const { map } = await buildInputMap(dir);
    const ep = map!.endpoints[0]!;
    // Since argument roles landed, a flow into a MITIGATABLE argument is generatable — `req.body.path`
    // reaches the fs `path` argument (traversal). Everything else must still be refused, with reasons.
    const pathFlow = ep.flows.find((f) => f.input === 'path' && f.confidence === 'precise')!;
    expect(pathFlow.argumentRole).toBe('path');
    expect(pathFlow.candidateFamily).toBe('path-traversal');
    expect(pathFlow.ruleGeneratable).toBe(true);
    // `req.query.data` lands in the fs CONTENT argument: proven, but not a blockable pattern.
    const dataFlow = ep.flows.find((f) => f.input === 'data' && f.confidence === 'precise');
    if (dataFlow) {
      expect(dataFlow.candidateFamily).toBeUndefined();
      expect(dataFlow.ruleGeneratable).toBe(false);
    }
    for (const f of ep.flows.filter((x) => x.ruleGeneratable === false)) {
      expect(f.ruleGeneratableReasons!.length).toBeGreaterThan(0);
    }
    // A precise flow still must not be read as authorization to block.
    const routeParamFlow = ep.flows.find((f) => f.input === 'tenant');
    expect(routeParamFlow?.ruleGeneratableReasons?.join(' ')).toMatch(/route parameters are not exposed/i);
  });
});

describe('high-signal candidate families reach precise', () => {
  // These are the first candidate families a rule compiler would target (SSRF / traversal / command
  // injection). They read straight off `req.<namespace>.<field>` into the sink, and previously never
  // reached `precise` because the namespace segment made the read path mismatch the input name.
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ps-fams-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '4', axios: '1' } }));
    writeFileSync(join(dir, 'src', 'server.ts'), `
      import express from "express";
      import fs from "node:fs";
      import { exec } from "node:child_process";
      import axios from "axios";
      const app = express();
      app.post("/api/fetch", async (req, res) => { await axios.get(req.body.webhookUrl); res.end(); });
      app.post("/api/read", (req, res) => { res.end(fs.readFileSync(req.body.filename)); });
      app.post("/api/run", (req, res) => { exec(req.body.command); res.end(); });
      app.get("/api/search", (req, res) => { res.end(fs.readFileSync(req.query.file)); });
    `);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['/api/fetch', 'webhookUrl', 'http', 'post.webhookUrl'],
    ['/api/read', 'filename', 'fs', 'post.filename'],
    ['/api/run', 'command', 'exec', 'post.command'],
    ['/api/search', 'file', 'fs', 'get.file'],
  ])('%s: %s reaches the %s sink precisely with coordinate %s', async (route, input, kind, coord) => {
    const { map } = await buildInputMap(dir);
    const ep = map!.endpoints.find((e) => e.route === route)!;
    expect(ep.inputs.find((i) => i.name === input)?.runtimeParameter).toBe(coord);
    expect(ep.flows.some((f) => f.input === input && f.sink.kind === kind && f.confidence === 'precise')).toBe(true);
  });
});
