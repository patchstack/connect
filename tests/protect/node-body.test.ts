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
