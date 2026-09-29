import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';

/**
 * A request binding is a variable, not a name. Another binding that happens to share its name — in a
 * block, a callback parameter, an inner function's own `request` — is a different variable, and a read
 * of it is not a read of the request. Where one variable is assigned again, what reaches a sink through
 * it may no longer be the request value, so the read proves reachability but not an exact value.
 */
async function mapOf(files: Record<string, string>, deps: Record<string, string> = { next: '15.0.0' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-scope-'));
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

const route = 'app/api/run/route.ts';
const handler = (body: string) =>
  `import { exec } from 'node:child_process';\nexport async function POST(request: Request) {\n${body}\n  return new Response('ok');\n}\n`;
const flowOf = async (body: string, input = 'cmd') => {
  const map = await mapOf({ [route]: handler(body) });

  return map.endpoints[0]!.flows.find((f) => f.input === input);
};

describe('taint follows the binding, not its name', () => {
  it('proves a read through the request binding itself', async () => {
    const flow = await flowOf("  const body = await request.json();\n  const cmd = body.cmd;\n  exec(cmd);");

    expect(flow).toMatchObject({ confidence: 'exact-local', ruleGeneratable: true });
  });

  it('does not read a block-scoped binding as an outer one of the same name', async () => {
    const flow = await flowOf("  const body = await request.json();\n  const cmd = 'ls';\n  { const cmd = body.cmd; console.log(cmd); }\n  exec(cmd);");

    expect(flow?.confidence).toBe('heuristic');
    expect(flow?.ruleGeneratable).toBe(false);
  });

  it('does not read a callback parameter as a request binding of the same name', async () => {
    const flow = await flowOf("  const body = await request.json();\n  const cmd = body.cmd;\n  console.log(cmd);\n  ['ls'].forEach((cmd) => exec(cmd));");

    expect(flow?.confidence).toBe('heuristic');
  });

  it("does not read an inner function's own parameter as the request", async () => {
    const flow = await flowOf("  const { cmd } = await request.json();\n  console.log(cmd);\n  [{ cmd: 'ls' }].map((request) => exec(request.cmd));");

    expect(flow?.confidence).toBe('heuristic');
  });

  it("does not inventory fields read off an inner function's own parameter", async () => {
    const map = await mapOf({ [route]: handler("  const rows = [{ query: { id: 1 } }];\n  rows.map((request) => request.query.id);") });

    expect(map.endpoints[0]!.inputs).toEqual([]);
  });

  it('still inventories fields read off the request inside a callback', async () => {
    const map = await mapOf({ [route]: handler("  [1].map(() => request.headers.get('x-trace'));") });

    expect(map.endpoints[0]!.inputs.map((i) => i.name)).toEqual(['x-trace']);
  });

  it('does not claim an exact value through a binding that is assigned again', async () => {
    const flow = await flowOf("  const body = await request.json();\n  let cmd = body.cmd;\n  cmd = 'ls';\n  exec(cmd);");

    expect(flow?.confidence).toBe('transformed-local');
  });

  it('carries the reassignment to aliases taken from the reassigned binding', async () => {
    const flow = await flowOf("  let body = await request.json();\n  if (!body.cmd) body = { cmd: 'ls' };\n  const { cmd } = body;\n  exec(cmd);");

    expect(flow?.confidence).toBe('transformed-local');
  });

  it.each([
    ['a compound assignment', "  cmd += ' --help';"],
    ['an update expression', '  cmd++;'],
    ['a destructuring assignment', "  ({ cmd } = { cmd: 'ls' });"],
    ['an array destructuring assignment', "  [cmd] = ['ls'];"],
    ['a for-of head', "  for (cmd of ['ls']) console.log(cmd);"],
  ])('treats %s as a reassignment', async (_label, statement) => {
    const flow = await flowOf(`  const body = await request.json();\n  let cmd = body.cmd;\n${statement}\n  exec(cmd);`);

    expect(flow?.confidence).toBe('transformed-local');
  });

  it('reports a dependency argument through a reassigned binding as within an expression', async () => {
    const map = await mapOf({
      'src/server.ts': "import express from 'express';\nimport reader from '@example/reader';\nconst app = express();\napp.post('/scan', (req, res) => {\n  let host = req.body.host;\n  host = host.trim();\n  reader.scan(host);\n  res.end();\n});\n",
    }, { express: '4', '@example/reader': '1' });
    const [link] = map.endpoints[0]!.dependencyInputFlows ?? [];

    expect(link).toMatchObject({ input: 'host', argumentUse: 'within-expression' });
  });
});

describe('same-file helpers resolve by scope', () => {
  const twoHandlers = (first: 'exec' | 'log') => {
    const execRun = "  const run = (v: string) => exec(v);";
    const logRun = "  const run = (v: string) => console.log(v);";
    return `import { exec } from 'node:child_process';\n`
      + `export async function POST(request: Request) {\n${first === 'exec' ? execRun : logRun}\n  run(request.headers.get('x-a'));\n  return new Response('');\n}\n`
      + `export async function PUT(request: Request) {\n${first === 'exec' ? logRun : execRun}\n  run(request.headers.get('x-b'));\n  return new Response('');\n}\n`;
  };
  const sinkKinds = (map: any, method: string) => map.endpoints.find((e: any) => e.method === method).sinks.map((s: any) => s.kind);

  it.each(['exec', 'log'] as const)('gives each handler its own local helper (exec helper in %s-first order)', async (first) => {
    const map = await mapOf({ [route]: twoHandlers(first) });

    expect(sinkKinds(map, first === 'exec' ? 'POST' : 'PUT')).toEqual(['exec']);
    expect(sinkKinds(map, first === 'exec' ? 'PUT' : 'POST')).toEqual([]);
  });

  it('still follows a module-level helper', async () => {
    const map = await mapOf({
      [route]: "import { exec } from 'node:child_process';\nfunction run(v: string) { exec(v); }\nexport async function POST(request: Request) {\n  run(request.headers.get('x-a'));\n  return new Response('');\n}\n",
    });

    expect(sinkKinds(map, 'POST')).toEqual(['exec']);
  });

  it('does not follow an imported helper when a local of the same name is called', async () => {
    const map = await mapOf({
      'lib/save.ts': "import { exec } from 'node:child_process';\nexport function save(v: string) { exec(v); }\n",
      [route]: "import { save } from '../../../lib/save';\nexport async function POST(request: Request) {\n  const save = (v: string) => console.log(v);\n  save(request.headers.get('x-a'));\n  return new Response('');\n}\n",
    });

    expect(sinkKinds(map, 'POST')).toEqual([]);
  });

  it('follows the exported helper, not a nested function of the same name in that module', async () => {
    const map = await mapOf({
      'lib/save.ts': "import { exec } from 'node:child_process';\nexport function save(v: string) { exec(v); }\nexport function other() {\n  const save = () => 1;\n  return save();\n}\n",
      [route]: "import { save } from '../../../lib/save';\nexport async function POST(request: Request) {\n  save(request.headers.get('x-a'));\n  return new Response('');\n}\n",
    });

    expect(sinkKinds(map, 'POST')).toEqual(['exec']);
  });

  it('follows the imported helper when that is what the call names', async () => {
    const map = await mapOf({
      'lib/save.ts': "import { exec } from 'node:child_process';\nexport function save(v: string) { exec(v); }\n",
      [route]: "import { save } from '../../../lib/save';\nexport async function POST(request: Request) {\n  save(request.headers.get('x-a'));\n  return new Response('');\n}\n",
    });

    expect(sinkKinds(map, 'POST')).toEqual(['exec']);
  });
});
