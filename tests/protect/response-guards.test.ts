import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createProtection, createSupabaseGuard, GUARD_PATH } from '../../src/protect/runtime.js';

// Opt-in response screening across the non-fetch surfaces: the Supabase tunnel guard, the
// Node/Connect adapter, and the Express adapter. The fetch() path is covered in tier3.test.ts;
// here we prove the same redact/withhold verdicts reach the buffered Node/Express response and
// the forwarded Supabase upstream — and that node()/express() only screen when opted in.

const AWS = 'AKIAIOSFODNN7EXAMPLE';

// --- a Node ServerResponse-like mock that wrapNodeResponse can wrap (write/end/*Header) ---
function mockRes() {
  const out: Buffer[] = [];
  return {
    statusCode: 200,
    _headers: {} as Record<string, unknown>,
    ended: false,
    body: '',
    setHeader(k: string, v: unknown) { this._headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return this._headers[k.toLowerCase()]; },
    removeHeader(k: string) { delete this._headers[k.toLowerCase()]; },
    write(chunk: any) { out.push(Buffer.from(chunk)); return true; },
    end(chunk?: any) {
      if (chunk != null && typeof chunk !== 'function') out.push(Buffer.from(chunk));
      this.body = Buffer.concat(out).toString('utf8');
      this.ended = true;
    },
  };
}

function mockReq({ method = 'GET', url = '/', headers = {} as Record<string, string>, body = '' } = {}) {
  const req: any = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: '9.9.9.9' };
  return req;
}

// --- Supabase tunnel guard: screen the forwarded upstream response ---
describe('supabase guard — response screening', () => {
  const SUPA = 'https://proj.supabase.co';
  const guardReq = () =>
    new Request(`https://app.example.com${GUARD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ps-target': `${SUPA}/rest/v1/tasks` },
      body: JSON.stringify({ title: 'ok' }),
    });

  it('redacts a secret leaked in the Supabase result', async () => {
    const protection = await createProtection({ mode: 'block' }); // default response rules
    const upstream = (async () =>
      new Response(JSON.stringify([{ id: 1, api_key: AWS }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as any;
    const handle = createSupabaseGuard({ protection, supabaseUrl: SUPA, fetchImpl: upstream });
    const res = await handle(guardReq());
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body.includes(AWS)).toBe(false);
    expect(body.includes('[REDACTED]')).toBe(true);
  });

  it('dry-run leaves the Supabase result untouched (observe only)', async () => {
    const protection = await createProtection({ mode: 'dry-run' });
    const upstream = (async () =>
      new Response(JSON.stringify([{ api_key: AWS }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as any;
    const handle = createSupabaseGuard({ protection, supabaseUrl: SUPA, fetchImpl: upstream });
    const body = await (await handle(guardReq())).text();
    expect(body.includes(AWS)).toBe(true);
  });
});

// --- Node adapter: opt-in wrapNodeResponse ---
describe('node() — response screening', () => {
  // Drive the middleware, then let the "app" write the response inside next().
  function run(mw: any, req: any, res: any, appEnd: (res: any) => void) {
    return new Promise<void>((resolve) => {
      mw(req, res, () => { appEnd(res); resolve(); });
    });
  }
  const leakyApp = (res: any) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ api_key: AWS }));
  };

  it('redacts a secret in the response when screenResponses is set', async () => {
    const p = await createProtection({ mode: 'block' });
    const res = mockRes();
    await run(p.node({ screenResponses: true }), mockReq(), res, leakyApp);
    expect(res.body.includes(AWS)).toBe(false);
    expect(res.body.includes('[REDACTED]')).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('does NOT screen the response when screenResponses is omitted', async () => {
    const p = await createProtection({ mode: 'block' });
    const res = mockRes();
    await run(p.node(), mockReq(), res, leakyApp);
    expect(res.body.includes(AWS)).toBe(true);
  });

  it('withholds (500) when a block-action rule matches the response', async () => {
    const p = await createProtection({
      mode: 'block',
      responseRules: [
        { phase: 'response', category: 'x', action: 'block', rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'TOPSECRET' } }] },
      ],
    });
    const res = mockRes();
    await run(p.node({ screenResponses: true }), mockReq(), res, (r: any) => {
      r.setHeader('content-type', 'application/json');
      r.end(JSON.stringify({ v: 'TOPSECRET' }));
    });
    expect(res.statusCode).toBe(500);
    expect(res.body.includes('TOPSECRET')).toBe(false);
  });

  it('passes a genuinely binary octet-stream through unscanned', async () => {
    const p = await createProtection({ mode: 'block' });
    const res = mockRes();
    // A binary body (leading NUL) sniffs as binary → passed through untouched, not scanned/corrupted.
    const bin = Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(AWS)]);
    await run(p.node({ screenResponses: true }), mockReq(), res, (r: any) => {
      r.setHeader('content-type', 'application/octet-stream');
      r.end(bin);
    });
    expect(res.body.includes(AWS)).toBe(true); // untouched
  });

  it('screens a TEXTUAL octet-stream (misdeclared JSON/text export)', async () => {
    const p = await createProtection({ mode: 'block' });
    const res = mockRes();
    // octet-stream carrying plain text with a secret — an export/config blob — is now screened.
    await run(p.node({ screenResponses: true }), mockReq(), res, (r: any) => {
      r.setHeader('content-type', 'application/octet-stream');
      r.end(JSON.stringify({ awsKey: AWS }));
    });
    expect(res.body.includes(AWS)).toBe(false);
    expect(res.body.includes('[REDACTED]')).toBe(true);
  });
});

// --- Express adapter: opt-in wrapNodeResponse ---
describe('express() — response screening', () => {
  // express() evaluates synchronously; simulate the parsed req + app response.
  function run(mw: any, req: any, res: any, appEnd: (res: any) => void) {
    return new Promise<void>((resolve) => {
      mw(req, res, () => { appEnd(res); resolve(); });
    });
  }

  it('redacts a secret in the response when screenResponses is set', async () => {
    const p = await createProtection({ mode: 'block' });
    const res = mockRes();
    const req: any = { method: 'GET', url: '/', query: {}, body: {}, headers: {} };
    await run(p.express({ screenResponses: true }), req, res, (r: any) => {
      r.setHeader('content-type', 'application/json');
      r.end(JSON.stringify({ api_key: AWS }));
    });
    expect(res.body.includes(AWS)).toBe(false);
    expect(res.body.includes('[REDACTED]')).toBe(true);
  });

  it('does NOT screen when screenResponses is omitted', async () => {
    const p = await createProtection({ mode: 'block' });
    const res = mockRes();
    const req: any = { method: 'GET', url: '/', query: {}, body: {}, headers: {} };
    await run(p.express(), req, res, (r: any) => {
      r.setHeader('content-type', 'application/json');
      r.end(JSON.stringify({ api_key: AWS }));
    });
    expect(res.body.includes(AWS)).toBe(true);
  });
});
