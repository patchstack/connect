import { describe, it } from 'vitest';
import assert from 'node:assert';
import { RequestResolver } from '../../src/protect/engine/request.js';

function createReq(overrides = {}) {
  return {
    method: 'GET',
    url: '/test?q=hello',
    originalUrl: '/test?q=hello',
    query: { q: 'hello' },
    body: {},
    headers: { 'user-agent': 'TestBot/1.0', cookie: 'session=abc123; lang=en' },
    ...overrides
  };
}

describe('RequestResolver', () => {

  describe('resolve get.*', () => {

    it('should resolve query parameters', () => {
      const resolver = new RequestResolver(createReq({ query: { name: 'test' } }));
      assert.deepStrictEqual(resolver.resolve('get.name'), ['test']);
    });

    it('should return empty for missing query params', () => {
      const resolver = new RequestResolver(createReq());
      assert.deepStrictEqual(resolver.resolve('get.missing'), []);
    });

    it('should resolve wildcard query params', () => {
      const resolver = new RequestResolver(createReq({
        query: { field_name: 'a', field_email: 'b', other: 'c' }
      }));
      const values = resolver.resolve('get.field_*');
      assert.strictEqual(values.length, 2);
      assert.ok(values.includes('a'));
      assert.ok(values.includes('b'));
    });

  });

  describe('resolve post.*', () => {

    it('should resolve body parameters', () => {
      const resolver = new RequestResolver(createReq({ body: { action: 'save' } }));
      assert.deepStrictEqual(resolver.resolve('post.action'), ['save']);
    });

    it('should resolve nested body values', () => {
      const resolver = new RequestResolver(createReq({
        body: { user: { name: 'test' } }
      }));
      assert.deepStrictEqual(resolver.resolve('post.user.name'), ['test']);
    });

    it('should return empty for missing body params', () => {
      const resolver = new RequestResolver(createReq());
      assert.deepStrictEqual(resolver.resolve('post.missing'), []);
    });

  });

  describe('resolve request.*', () => {

    it('should check query first', () => {
      const resolver = new RequestResolver(createReq({
        query: { key: 'from-query' },
        body: { key: 'from-body' }
      }));
      assert.deepStrictEqual(resolver.resolve('request.key'), ['from-query']);
    });

    it('should fall back to body', () => {
      const resolver = new RequestResolver(createReq({
        query: {},
        body: { key: 'from-body' }
      }));
      assert.deepStrictEqual(resolver.resolve('request.key'), ['from-body']);
    });

    it('should fall back to cookies', () => {
      const resolver = new RequestResolver(createReq({
        query: {},
        body: {},
        headers: { cookie: 'key=from-cookie' }
      }));
      assert.deepStrictEqual(resolver.resolve('request.key'), ['from-cookie']);
    });

  });

  describe('resolve cookie.*', () => {

    it('should parse cookies from header', () => {
      const resolver = new RequestResolver(createReq());
      assert.deepStrictEqual(resolver.resolve('cookie.session'), ['abc123']);
      assert.deepStrictEqual(resolver.resolve('cookie.lang'), ['en']);
    });

    it('should use req.cookies if available', () => {
      const resolver = new RequestResolver(createReq({
        cookies: { session: 'pre-parsed' },
        headers: {}
      }));
      assert.deepStrictEqual(resolver.resolve('cookie.session'), ['pre-parsed']);
    });

    it('should return empty for missing cookies', () => {
      const resolver = new RequestResolver(createReq({ headers: {} }));
      assert.deepStrictEqual(resolver.resolve('cookie.missing'), []);
    });

  });

  describe('resolve server.*', () => {

    it('should resolve REQUEST_URI', () => {
      const resolver = new RequestResolver(createReq());
      assert.deepStrictEqual(resolver.resolve('server.REQUEST_URI'), ['/test?q=hello']);
    });

    it('should resolve REQUEST_METHOD', () => {
      const resolver = new RequestResolver(createReq({ method: 'POST' }));
      assert.deepStrictEqual(resolver.resolve('server.REQUEST_METHOD'), ['POST']);
    });

    it('should resolve HTTP_USER_AGENT', () => {
      const resolver = new RequestResolver(createReq());
      assert.deepStrictEqual(resolver.resolve('server.HTTP_USER_AGENT'), ['TestBot/1.0']);
    });

    it('should resolve arbitrary HTTP_ headers', () => {
      const resolver = new RequestResolver(createReq({
        headers: { 'x-forwarded-for': '1.2.3.4' }
      }));
      assert.deepStrictEqual(resolver.resolve('server.HTTP_X_FORWARDED_FOR'), ['1.2.3.4']);
    });

    it('should resolve REMOTE_ADDR from ip', () => {
      const resolver = new RequestResolver(createReq({ ip: '10.0.0.1' }));
      assert.deepStrictEqual(resolver.resolve('server.REMOTE_ADDR'), ['10.0.0.1']);
    });

  });

  describe('resolve raw', () => {

    it('should return string body as-is', () => {
      const resolver = new RequestResolver(createReq({ body: '{"key":"value"}' }));
      assert.deepStrictEqual(resolver.resolve('raw'), ['{"key":"value"}']);
    });

    it('should JSON-stringify object body', () => {
      const resolver = new RequestResolver(createReq({ body: { key: 'value' } }));
      const values = resolver.resolve('raw');
      assert.strictEqual(values.length, 1);
      assert.strictEqual(JSON.parse(values[0]).key, 'value');
    });

    it('should return empty for null body', () => {
      const resolver = new RequestResolver(createReq({ body: null }));
      assert.deepStrictEqual(resolver.resolve('raw'), []);
    });

  });

  describe('resolve all', () => {

    it('should combine url, query, body, headers, and cookies', () => {
      const resolver = new RequestResolver(createReq({
        body: { payload: 'test' },
        headers: { 'user-agent': 'TestBot', cookie: 'session=abc' }
      }));
      const values = resolver.resolve('all');
      assert.strictEqual(values.length, 1);
      assert.ok(values[0].includes('/test?q=hello'));
      assert.ok(values[0].includes('payload'));
      assert.ok(values[0].includes('user-agent'));
      assert.ok(values[0].includes('session=abc'));
    });

  });

  describe('resolve special', () => {

    it('should return [null] for rules parameter', () => {
      const resolver = new RequestResolver(createReq());
      assert.deepStrictEqual(resolver.resolve('rules'), [null]);
    });

    it('should return [null] for false parameter', () => {
      const resolver = new RequestResolver(createReq());
      assert.deepStrictEqual(resolver.resolve('false'), [null]);
    });

    it('should return empty for unknown source', () => {
      const resolver = new RequestResolver(createReq());
      assert.deepStrictEqual(resolver.resolve('unknown.key'), []);
    });

  });

  describe('applyMutations', () => {

    it('should apply base64_decode', () => {
      const resolver = new RequestResolver(createReq());
      const result = resolver.applyMutations(['base64_decode'], Buffer.from('hello').toString('base64'));
      assert.strictEqual(result, 'hello');
    });

    it('should apply json_decode', () => {
      const resolver = new RequestResolver(createReq());
      const result = resolver.applyMutations(['json_decode'], '{"key":"value"}');
      assert.deepStrictEqual(result, { key: 'value' });
    });

    it('should apply urldecode', () => {
      const resolver = new RequestResolver(createReq());
      const result = resolver.applyMutations(['urldecode'], 'hello%20world');
      assert.strictEqual(result, 'hello world');
    });

    it('should apply intval', () => {
      const resolver = new RequestResolver(createReq());
      assert.strictEqual(resolver.applyMutations(['intval'], '42abc'), 42);
    });

    it('should chain mutations', () => {
      const resolver = new RequestResolver(createReq());
      const encoded = Buffer.from('{"key":"value"}').toString('base64');
      const result = resolver.applyMutations(['base64_decode', 'json_decode'], encoded);
      assert.deepStrictEqual(result, { key: 'value' });
    });

    it('should handle null mutations array', () => {
      const resolver = new RequestResolver(createReq());
      assert.strictEqual(resolver.applyMutations(null, 'test'), 'test');
    });

  });

});

describe('resolveRaw with _rawBody (prototype pollution)', () => {

    it('should use _rawBody when set by normalizeRequest', () => {
        const req = {
            body: {},
            _rawBody: '{"__proto__":{"admin":true}}'
        };
        const resolver = new RequestResolver(req);
        const values = resolver.resolve('raw');
        assert.strictEqual(values.length, 1);
        assert.strictEqual(values[0], '{"__proto__":{"admin":true}}');
    });

    it('should fall back to body string when _rawBody is absent', () => {
        const req = {
            body: '{"test":"value"}'
        };
        const resolver = new RequestResolver(req);
        const values = resolver.resolve('raw');
        assert.strictEqual(values.length, 1);
        assert.ok(values[0].includes('test'));
    });

    it('should fall back to JSON.stringify when _rawBody is absent and body is object', () => {
        const req = {
            body: { key: 'value' }
        };
        const resolver = new RequestResolver(req);
        const values = resolver.resolve('raw');
        assert.strictEqual(values.length, 1);
        assert.ok(values[0].includes('key'));
    });

    it('should return empty array when _rawBody is empty string', () => {
        const req = {
            body: null,
            _rawBody: ''
        };
        const resolver = new RequestResolver(req);
        const values = resolver.resolve('raw');
        assert.deepStrictEqual(values, []);
    });

    it('should ignore body entirely when _rawBody is set (even to empty string)', () => {
        const req = {
            body: '{"sensitive":"data"}',
            _rawBody: ''
        };
        const resolver = new RequestResolver(req);
        const values = resolver.resolve('raw');
        // _rawBody takes priority — body is ignored, empty _rawBody means "no body"
        assert.deepStrictEqual(values, []);
    });

    describe('resolve response.* (response phase)', () => {
        const resolver = () => new RequestResolver({
            _response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"key":"secret"}' }
        });

        it('resolves response.body / status / header.*', () => {
            assert.deepStrictEqual(resolver().resolve('response.body'), ['{"key":"secret"}']);
            assert.deepStrictEqual(resolver().resolve('response.status'), ['200']);
            assert.deepStrictEqual(resolver().resolve('response.header.content-type'), ['application/json']);
        });

        it('returns [] when no response context', () => {
            assert.deepStrictEqual(new RequestResolver({}).resolve('response.body'), []);
        });
    });

    describe('resolve egress.* (egress phase)', () => {
        const resolver = () => new RequestResolver({
            _egress: { url: 'http://169.254.169.254/latest/meta-data/', host: '169.254.169.254', method: 'GET' }
        });

        it('resolves egress.host / url / method', () => {
            assert.deepStrictEqual(resolver().resolve('egress.host'), ['169.254.169.254']);
            assert.deepStrictEqual(resolver().resolve('egress.url'), ['http://169.254.169.254/latest/meta-data/']);
            assert.deepStrictEqual(resolver().resolve('egress.method'), ['GET']);
        });
    });

});
