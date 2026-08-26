import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMap } from '../../src/map-command.js';

/**
 * Whether a map is worth uploading is decided in the CLI, so it is asserted there.
 *
 * A map with no recognized entry points still carries the import inventory, the recorded API
 * invocations, the deployment shapes and the coverage limitations — everything the `imported`,
 * `not-imported` and `api-called` tiers are decided from, none of which needs an endpoint. Withholding
 * it made "we could not judge this" indistinguishable from "we never looked", and the receiving end has
 * always accepted it: `endpoints` is validated as `present`, not `required|min:1`.
 */
const projects: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-upload-'));
  projects.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

function captureUploads() {
  const sent: Array<{ url: string; body: any }> = [];
  vi.stubGlobal('fetch', async (url: any, init: any) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ result: 'stored', revision: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return sent;
}

const upload = (dir: string) =>
  runMap(
    new Map<string, string | true>([
      ['dir', dir],
      ['upload', true],
      ['site-uuid', '47acf878-4892-4756-94d3-d7bc5ae4e46d'],
      ['endpoint', 'https://api.test/monitor/pulse/manifest'],
    ]),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a map with no recognized entry points', () => {
  it('is still uploaded, carrying the import inventory', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'x', dependencies: { lodash: '4.17.20' } }),
      // A library file: a real import, and nothing a route recognizer can see.
      'src/util.ts': "import { merge } from 'lodash';\nexport const m = (a: any, b: any) => merge(a, b);\n",
    });

    const sent = captureUploads();
    await expect(upload(dir)).resolves.toBe(0);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/monitor/pulse/input-map/47acf878-4892-4756-94d3-d7bc5ae4e46d');
    expect(sent[0].body.endpoints).toEqual([]);
    // The half that makes it worth sending.
    expect(JSON.stringify(sent[0].body.imports ?? [])).toContain('lodash');
  });

  it('says what the map cannot decide, rather than calling it nothing', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'x', dependencies: { lodash: '4.17.20' } }),
      'src/util.ts': "import { merge } from 'lodash';\nexport const m = (a: any) => merge(a, {});\n",
    });
    captureUploads();
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

    await upload(dir);
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    warn.mockRestore();

    expect(said).not.toContain('nothing to upload');
    expect(said).toContain('no server entry points were recognized');
  });
});

describe('a map with entry points', () => {
  it('is uploaded as before — the control for the case above', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'x', dependencies: { express: '4.18.0' } }),
      'src/server.ts':
        "import express from 'express';\nconst app = express();\napp.post('/report', (req, res) => { res.end(String(req.body.sql)); });\n",
    });

    const sent = captureUploads();
    await expect(upload(dir)).resolves.toBe(0);

    expect(sent).toHaveLength(1);
    expect(sent[0].body.endpoints.length).toBeGreaterThan(0);
  });
});
