import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createProtection } from '../../src/protect/runtime.js';
import { createNodeMiddleware, readBodyPrefix } from '../../src/protect/engine/node.js';

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

const readPrefix = (req: any, max: number) =>
  new Promise<any>((resolve, reject) => readBodyPrefix(req, max, (error: any, read: any) => (error ? reject(error) : resolve(read))));

describe('the retained prefix', () => {
  it.each([
    ['a two-byte', 'é'],
    ['a three-byte', '€'],
    ['a four-byte', '😀'],
  ])('ends before %s character the cap falls inside', async (_label, char) => {
    const width = Buffer.byteLength(char);
    for (let max = width * 3 + 1; max < width * 4; max++) {
      const read = await readPrefix(Readable.from([Buffer.from(char.repeat(10))]), max);
      expect(read.text, `cap ${max}`).toBe(char.repeat(3));
      expect(read.overflow).toBe(true);
    }
  });

  it.each(['utf8', 'latin1', 'hex'] as const)('counts bytes, not characters, after setEncoding(%s)', async (encoding) => {
    const req: any = Readable.from([Buffer.from('é'.repeat(40))]);
    req.setEncoding(encoding);
    const read = await readPrefix(req, 63);
    expect(read.text).toBe('é'.repeat(31));
    expect(read.size).toBe(80);
    expect(read.overflow).toBe(true);
  });

  it('leaves the end of a complete body as it was sent', async () => {
    // Only a prefix the cap cut short is trimmed; a whole body is decoded as the application decodes it.
    const read = await readPrefix(Readable.from([Buffer.concat([Buffer.from('abc'), Buffer.from([0xc3])])]), 64);
    expect(read.text).toBe('abc�');
    expect(read.overflow).toBe(false);
  });

  it('keeps a complete body whole after setEncoding', async () => {
    const req: any = Readable.from([Buffer.from('{"note":"é"}')]);
    req.setEncoding('utf8');
    const read = await readPrefix(req, 64);
    expect(read).toEqual({ text: '{"note":"é"}', overflow: false, size: 13, failed: false });
  });
});

describe.each([
  ['protection.node()', async () => (await createProtection({ rules, mode: 'block' } as any)).node({ maxBodyBytes: 64 })],
  ['createNodeMiddleware', async () => createNodeMiddleware(rules, { maxBodyBytes: 64 })],
])('%s after setEncoding', (_label, make) => {
  const encoded = (body: string) => {
    const req = mockReq(body);
    req.setEncoding('utf8');
    return req;
  };

  it('screens and exposes a body within the cap', async () => {
    expect((await run(await make(), encoded(early.slice(0, 40) + '"}'))).passed).toBe(false);
    const req = encoded(small);
    expect((await run(await make(), req)).passed).toBe(true);
    expect(req.body).toEqual({ note: 'plain' });
  });

  it('screens the beginning of a body longer than the cap', async () => {
    expect((await run(await make(), encoded(early))).passed).toBe(false);
  });
});

describe('a chunk the reader cannot use', () => {
  // An object-mode stream delivers values that are neither bytes nor text.
  const objectReq = () => {
    const req: any = Readable.from([{ note: 'sample-marker' }]);
    req.method = 'POST';
    req.url = '/';
    req.headers = { 'content-type': 'application/json', host: 'app.test' };
    req.socket = { remoteAddress: '198.51.100.7' };
    return req;
  };

  it('fails open on protection.node() and reports it', async () => {
    const protection: any = await createProtection({ rules, mode: 'block' } as any);
    const req = objectReq();
    expect((await run(protection.node(), req)).passed).toBe(true);
    expect(req.body).toBeUndefined();
    expect(protection.coverage().skipped['request:read-failed']).toBe(1);
  });

  it('fails open on createNodeMiddleware and reports it', async () => {
    const skips: any[] = [];
    const req = objectReq();
    expect((await run(createNodeMiddleware(rules, { onSkip: (skip: any) => skips.push(skip) }), req)).passed).toBe(true);
    expect(req.body).toBeUndefined();
    expect(skips).toEqual([{ phase: 'request', reason: 'read-failed' }]);
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
