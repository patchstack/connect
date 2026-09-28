import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createProtection } from '../../src/protect/runtime.js';
import { createNodeMiddleware } from '../../src/protect/engine/node.js';

// A Node request body longer than the cap: the beginning is screened, as on the Fetch path, the cap is
// reported, and the cut-off body is not handed on as though it were the whole one.

const rules = {
  firewall: [{ id: 'b', title: 'body marker', rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: 'sample-marker' } }] }],
  whitelists: [],
  whitelist_keys: {},
};

// Delivered in small chunks, so the cap falls inside a chunk rather than on a boundary.
function mockReq(body: string) {
  const bytes = Buffer.from(body);
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7));
  const req: any = Readable.from(chunks);
  req.method = 'POST';
  req.url = '/';
  req.headers = { 'content-type': 'application/json', host: 'app.test' };
  req.socket = { remoteAddress: '198.51.100.7' };
  return req;
}

function run(guard: any, req: any): Promise<{ passed: boolean; status: number }> {
  const res: any = { statusCode: 200, setHeader() {}, getHeader() {}, end() {} };
  return new Promise((resolve) => {
    res.end = () => resolve({ passed: false, status: res.statusCode });
    guard(req, res, () => resolve({ passed: true, status: res.statusCode }));
  });
}

const early = JSON.stringify({ note: 'sample-marker', pad: 'x'.repeat(500) });
const late = JSON.stringify({ pad: 'x'.repeat(500), note: 'sample-marker' });
const small = JSON.stringify({ note: 'plain' });

describe.each([
  ['protection.node()', async () => (await createProtection({ rules, mode: 'block' } as any)).node({ maxBodyBytes: 64 })],
  ['createNodeMiddleware', async () => createNodeMiddleware(rules, { maxBodyBytes: 64 })],
])('%s with a body longer than the cap', (_label, make) => {
  it('screens the beginning of the body', async () => {
    const { passed, status } = await run(await make(), mockReq(early));
    expect(passed).toBe(false);
    expect(status).toBe(403);
  });

  it('screens exactly the first maxBodyBytes, including a chunk that crosses the cap', async () => {
    const lead = '{"a":"';
    const endsAt = (end: number) => lead + 'x'.repeat(end - lead.length - 'sample-marker'.length) + 'sample-marker' + 'y'.repeat(200) + '"}';
    // 64 is not a multiple of the 7-byte chunk size, so the chunk holding the cap is partly retained.
    expect((await run(await make(), mockReq(endsAt(64)))).passed).toBe(false);
    expect((await run(await make(), mockReq(endsAt(65)))).passed).toBe(true);
  });

  it('does not expose the cut-off body as req.body', async () => {
    const req = mockReq(late);
    const { passed } = await run(await make(), req);
    expect(passed).toBe(true);
    expect(req.body).toBeUndefined();
  });

  it('still exposes a body within the cap', async () => {
    const req = mockReq(small);
    const { passed } = await run(await make(), req);
    expect(passed).toBe(true);
    expect(req.body).toEqual({ note: 'plain' });
  });
});

describe('reporting the cap', () => {
  it('counts it on protection.node()', async () => {
    const protection: any = await createProtection({ rules, mode: 'block' } as any);
    await run(protection.node({ maxBodyBytes: 64 }), mockReq(late));
    expect(protection.coverage().skipped['request:body-cap']).toBe(1);
  });

  it('reports it to onSkip on createNodeMiddleware', async () => {
    const skips: any[] = [];
    await run(createNodeMiddleware(rules, { maxBodyBytes: 64, onSkip: (skip: any) => skips.push(skip) }), mockReq(late));
    expect(skips).toEqual([{ phase: 'request', reason: 'body-cap' }]);
  });

  it('reports nothing for a body within the cap', async () => {
    const skips: any[] = [];
    await run(createNodeMiddleware(rules, { maxBodyBytes: 64, onSkip: (skip: any) => skips.push(skip) }), mockReq(small));
    expect(skips).toEqual([]);
  });
});
