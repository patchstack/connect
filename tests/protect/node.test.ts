import { describe, it } from 'vitest';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import { createNodeMiddleware, fromNodeRequest } from '../../src/protect/engine/node.js';

const rules = {
  firewall: [
    {
      id: 1,
      title: 'block path traversal',
      rule_v2: [
        {
          parameter: 'get.file',
          mutations: ['urldecode'],
          match: { type: 'contains', value: '..' }
        }
      ]
    }
  ],
  whitelists: [],
  whitelist_keys: {}
};

// Minimal IncomingMessage-like stream + a mock ServerResponse.
function mockReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: '9.9.9.9' };
  return req;
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    ended: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(chunk) {
      this.body = chunk || '';
      this.ended = true;
    }
  };
}

// Run the middleware and resolve with { res, nextCalled, nextErr }.
function run(mw, req, res) {
  return new Promise((resolve) => {
    const originalEnd = res.end.bind(res);
    res.end = (chunk) => {
      originalEnd(chunk);
      resolve({ res, nextCalled: false });
    };
    mw(req, res, (err) => resolve({ res, nextCalled: true, nextErr: err }));
  });
}

describe('node adapter', () => {
  it('fromNodeRequest parses query, JSON body, ip, and verbatim _rawBody', () => {
    const shaped = fromNodeRequest(
      { method: 'POST', url: '/api?q=1&q=2', headers: { 'content-type': 'application/json', host: 'x' }, socket: {} },
      JSON.stringify({ a: 1 })
    );
    assert.deepStrictEqual(shaped.query.q, ['1', '2']);
    assert.strictEqual(shaped.body.a, 1);
    assert.strictEqual(shaped._rawBody, JSON.stringify({ a: 1 }));
    assert.strictEqual(shaped.originalUrl, '/api?q=1&q=2');
  });

  it('blocks a malicious request with a 403', async () => {
    const mw = createNodeMiddleware(rules);
    const { res, nextCalled } = await run(mw, mockReq({ url: '/read?file=..%2f..%2fetc' }), mockRes());
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(JSON.parse(res.body).error, 'Blocked by Patchstack WAF');
  });

  it('calls next() and sets req.body for a benign request', async () => {
    const mw = createNodeMiddleware(rules);
    const req = mockReq({
      method: 'POST',
      url: '/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hi' })
    });
    const { nextCalled, nextErr } = await run(mw, req, mockRes());
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(nextErr, undefined);
    assert.deepStrictEqual(req.body, { title: 'hi' });
  });

  it('fails open (calls next) when the engine throws', async () => {
    let captured = null;
    const mw = createNodeMiddleware(
      { evaluate() { throw new Error('boom'); } },
      { onError: (e) => (captured = e) }
    );
    const { nextCalled } = await run(mw, mockReq({ url: '/x' }), mockRes());
    assert.strictEqual(nextCalled, true);
    assert.ok(captured instanceof Error);
  });

  it('skips inspecting an oversized body (fail open) rather than buffering unbounded', async () => {
    const mw = createNodeMiddleware(rules, { maxBodyBytes: 8 });
    const req = mockReq({
      method: 'POST',
      url: '/save',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ big: 'x'.repeat(1000) })
    });
    const { nextCalled } = await run(mw, req, mockRes());
    assert.strictEqual(nextCalled, true); // not blocked; body skipped
  });
});
