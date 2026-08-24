import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createProtection } from '../../src/protect/runtime.js';

const rules = {
  firewall: [{ id: 'b', rule_v2: [{ parameter: 'post.title', match: { type: 'contains', value: 'evil' } }] }],
  whitelists: [],
  whitelist_keys: {},
};

function mockReq({ headers = {}, body = '' }: any) {
  const r: any = Readable.from(body ? [Buffer.from(body)] : []);
  r.method = 'POST';
  r.url = '/';
  r.headers = headers;
  r.socket = { remoteAddress: '1.1.1.1' };
  return r;
}
function mockRes(): any {
  return { statusCode: 200, ended: false, setHeader() {}, end() { this.ended = true; } };
}
function run(mw: any, req: any, res: any): Promise<{ nexted: boolean }> {
  return new Promise((resolve) => {
    const origEnd = res.end.bind(res);
    res.end = (c: any) => { origEnd(c); resolve({ nexted: false }); };
    mw(req, res, () => resolve({ nexted: true }));
  });
}

describe('runtime node() re-exposes the buffered body', () => {
  it('sets req.body (parsed) so a downstream handler can read it after screening', async () => {
    const p = await createProtection({ rules, mode: 'block' });
    const req = mockReq({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'ok' }) });
    const { nexted } = await run(p.node(), req, mockRes());
    expect(nexted).toBe(true);
    expect(req.body).toEqual({ title: 'ok' }); // guard consumed the stream, then re-exposed it
  });

  it('does not clobber a req.body already set by an upstream parser', async () => {
    const p = await createProtection({ rules, mode: 'block' });
    const req = mockReq({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'ok' }) });
    req.body = { title: 'ok', fromParser: true };
    await run(p.node(), req, mockRes());
    expect(req.body.fromParser).toBe(true);
  });

  it('still blocks a match', async () => {
    const p = await createProtection({ rules, mode: 'block' });
    const res = mockRes();
    await run(p.node(), mockReq({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'evil' }) }), res);
    expect(res.statusCode).toBe(403);
  });
});

describe('runtime node() registered after a body parser', () => {
  /** Drain the stream, the way a body parser upstream would have. */
  async function drained(body: string) {
    const req = mockReq({ headers: { 'content-type': 'application/json' }, body });
    for await (const _chunk of req) void _chunk;

    return req;
  }

  it('answers the request instead of waiting for an end that already happened', async () => {
    // The ordering this guard needs is real — it reads the stream itself — but a wrong order has to fail by
    // screening less, not by holding the request open. 'data' and 'end' do not fire twice, so waiting on
    // them here would leave the client hanging until it gave up.
    const p = await createProtection({ rules, mode: 'block' });
    const req = await drained(JSON.stringify({ title: 'ok' }));

    const settled = await Promise.race([
      run(p.node(), req, mockRes()),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 200)),
    ]);

    expect(settled).toEqual({ nexted: true });
  });

  it('screens the body the parser left, rather than screening nothing', async () => {
    // The parsed body is used as it is rather than re-encoded: a form body handed back as JSON text would
    // resolve no `post.<field>` at all, which is a guard that runs and matches nothing.
    const p = await createProtection({ rules, mode: 'block' });
    const req = await drained(JSON.stringify({ title: 'evil' }));
    req.body = { title: 'evil' };
    const res = mockRes();

    await run(p.node(), req, res);

    expect(res.statusCode).toBe(403);
  });

  it('serves a request the parser left clean', async () => {
    // The control: the fast path must not turn into a block for everything it cannot read.
    const p = await createProtection({ rules, mode: 'block' });
    const req = await drained(JSON.stringify({ title: 'ok' }));
    req.body = { title: 'ok' };

    expect((await run(p.node(), req, mockRes())).nexted).toBe(true);
  });
});
