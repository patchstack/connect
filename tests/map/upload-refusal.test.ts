import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * A map the Patchstack API would refuse whole is not sent. Producing one for real takes thousands of
 * files, so the size check is stood in for here; `document-budget.test.ts` covers when it fires.
 */
vi.mock('../../src/map/budget.js', async (original) => ({
  ...(await original<typeof import('../../src/map/budget.js')>()),
  ingestProblems: () => ['60000 nodes, over the 49992 the upload can carry'],
}));

const { runMap } = await import('../../src/map-command.js');

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a map that cannot be fitted to the ingest limits', () => {
  it('is not uploaded, and the build is told why', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-refuse-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { express: '4.18.0' } }));
    writeFileSync(join(dir, 'src/server.ts'), "import express from 'express';\nconst app = express();\napp.post('/r', (req, res) => res.end(String(req.body.a)));\n");
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await runMap(new Map<string, string | true>([
      ['dir', dir], ['upload', true],
      ['site-uuid', '47acf878-4892-4756-94d3-d7bc5ae4e46d'], ['endpoint', 'https://api.test/monitor/pulse/manifest'],
    ]));
    const output = said.mock.calls.map((c) => String(c[0])).join('\n');
    said.mockRestore();

    expect(code).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(output).toContain('did not upload the attack surface');
    expect(output).toContain('60000 nodes');
  });
});
