import { describe, it } from 'vitest';
import assert from 'node:assert';
import { createFetchMiddleware, wrapFetchHandler, fromFetchRequest } from '../../src/protect/engine/fetch.js';

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

describe('fetch adapter', () => {
  it('fromFetchRequest parses query (repeats), headers, JSON body, ip, and verbatim _rawBody', async () => {
    const req = await fromFetchRequest(
      new Request('https://app.dev/api?q=1&q=2', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
        body: JSON.stringify({ a: 1 })
      })
    );
    assert.deepStrictEqual(req.query.q, ['1', '2']);
    assert.strictEqual(req.body.a, 1);
    // A WHATWG Request exposes no transport peer, so a forwarded header alone establishes nothing: it is
    // indistinguishable from one the caller wrote. The address is absent and its provenance says why.
    assert.strictEqual(req.ip, '');
    assert.strictEqual(req._clientIp.source, 'unavailable');
    assert.strictEqual(req._clientIp.ip, null);
    assert.strictEqual(req.headers['content-type'], 'application/json');
    assert.strictEqual(req._rawBody, JSON.stringify({ a: 1 }));
    assert.strictEqual(req.originalUrl, '/api?q=1&q=2');
  });

  it('guard blocks a malicious request with a 403 Response', async () => {
    const guard = createFetchMiddleware(rules);
    const res = await guard(new Request('https://app.dev/read?file=..%2f..%2fetc%2fpasswd'));
    assert.ok(res instanceof Response);
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.error, 'Blocked by Patchstack WAF');
  });

  it('guard returns null (allow) for a benign request', async () => {
    const guard = createFetchMiddleware(rules);
    const res = await guard(new Request('https://app.dev/read?file=notes.txt'));
    assert.strictEqual(res, null);
  });

  it('wrapFetchHandler calls through on allow and short-circuits on block', async () => {
    const handler = async () => new Response('ok', { status: 200 });
    const wrapped = wrapFetchHandler(handler, rules);

    const allowed = await wrapped(new Request('https://app.dev/read?file=ok.txt'));
    assert.strictEqual(allowed.status, 200);
    assert.strictEqual(await allowed.text(), 'ok');

    const blocked = await wrapped(new Request('https://app.dev/read?file=../secret'));
    assert.strictEqual(blocked.status, 403);
  });

  it('matches a __proto__ prototype-pollution payload via verbatim `raw` body', async () => {
    const ppRules = {
      firewall: [
        {
          id: 2,
          title: 'prototype pollution',
          rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '__proto__' } }]
        }
      ],
      whitelists: [],
      whitelist_keys: {}
    };
    const guard = createFetchMiddleware(ppRules);
    const res = await guard(
      new Request('https://app.dev/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"__proto__":{"polluted":"yes"}}'
      })
    );
    assert.strictEqual(res?.status, 403, '__proto__ in the verbatim body should be caught');
  });

  it('fails open when a rule throws (never blocks on engine error)', async () => {
    const badEngine = { evaluate() { throw new Error('boom'); } };
    let captured = null;
    const guard = createFetchMiddleware(badEngine, { onError: (e) => (captured = e) });
    const res = await guard(new Request('https://app.dev/x'));
    assert.strictEqual(res, null);
    assert.ok(captured instanceof Error);
  });
});
