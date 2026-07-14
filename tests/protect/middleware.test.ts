import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMiddleware, createLogger, protect, protectSync } from '../../src/protect/engine/middleware.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRules = JSON.parse(
  await readFile(join(__dirname, 'fixtures', 'rules-response.json'), 'utf-8')
);

let originalFetch;

function mockFetch(handler) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
}

function restoreFetch() {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}

function createReq(overrides = {}) {
  return {
    method: 'GET',
    url: '/test',
    originalUrl: '/test',
    query: {},
    body: {},
    headers: {},
    ...overrides
  };
}

function createRes() {
  let statusCode = 200;
  let body = null;
  let ended = false;
  const res = {
    get statusCode() { return statusCode; },
    set statusCode(v) { statusCode = v; },
    status(code) { statusCode = code; return res; },
    json(data) { body = data; return res; },
    end(...args) { ended = true; },
    _getBody() { return body; },
    _isEnded() { return ended; }
  };
  return res;
}

describe('Middleware', () => {

  afterEach(() => {
    restoreFetch();
  });

  describe('createMiddleware()', () => {

    it('should pass clean requests through', () => {
      const mw = createMiddleware(fixtureRules);
      const req = createReq({ query: { search: 'hello' } });
      const res = createRes();
      let nextCalled = false;

      mw(req, res, () => { nextCalled = true; });

      assert.ok(nextCalled);
    });

    it('should block malicious requests', () => {
      const mw = createMiddleware(fixtureRules);
      const req = createReq({ query: { search: '1 UNION SELECT *' } });
      const res = createRes();
      let nextCalled = false;

      mw(req, res, () => { nextCalled = true; });

      assert.ok(!nextCalled);
      assert.strictEqual(res.statusCode, 403);
    });

    it('should call onBlock callback', () => {
      let blockEvent = null;
      const mw = createMiddleware(fixtureRules, {
        onBlock: (event) => { blockEvent = event; }
      });
      const req = createReq({ query: { search: '1 UNION SELECT *' } });
      const res = createRes();

      mw(req, res, () => {});

      assert.ok(blockEvent);
      assert.ok(blockEvent.rule);
      assert.ok(blockEvent.request);
    });

    it('should expose engine on middleware', () => {
      const mw = createMiddleware(fixtureRules);
      assert.ok(mw.engine);
    });

  });

  describe('createLogger()', () => {

    it('should track request events', () => {
      const logger = createLogger();
      const req = createReq();
      const res = createRes();

      logger.middleware(req, res, () => {});
      res.end();

      const events = logger.getEvents();
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].method, 'GET');
      assert.strictEqual(events[0].blocked, false);
    });

    it('should track blocked requests', () => {
      const logger = createLogger();
      const req = createReq();
      const res = createRes();

      logger.middleware(req, res, () => {});
      res.statusCode = 403;
      res.end();

      const stats = logger.getStats();
      assert.strictEqual(stats.total, 1);
      assert.strictEqual(stats.blocked, 1);
      assert.strictEqual(stats.allowed, 0);
    });

    it('should track stats correctly', () => {
      const logger = createLogger();

      for (let i = 0; i < 3; i++) {
        const req = createReq();
        const res = createRes();
        logger.middleware(req, res, () => {});
        res.end();
      }

      const stats = logger.getStats();
      assert.strictEqual(stats.total, 3);
      assert.strictEqual(stats.allowed, 3);
    });

  });

  describe('protect()', () => {

    it('should return pass-through middleware when no token', async () => {
      const origToken = process.env.PATCHSTACK_WAF_TOKEN;
      delete process.env.PATCHSTACK_WAF_TOKEN;

      try {
        const mw = await protect();
        const req = createReq();
        const res = createRes();
        let nextCalled = false;

        mw(req, res, () => { nextCalled = true; });
        assert.ok(nextCalled, 'Should pass through when no token');
      } finally {
        if (origToken) {
          process.env.PATCHSTACK_WAF_TOKEN = origToken;
        }
      }
    });

    it('should fetch rules and create middleware', async () => {
      mockFetch(async () => ({
        ok: true,
        json: async () => fixtureRules
      }));

      const mw = await protect({ token: 'test-token' });

      assert.ok(mw.rules, 'Should have rules attached');
      assert.ok(mw.getStats, 'Should have getStats (logging enabled by default)');
      assert.ok(mw.getEvents, 'Should have getEvents');
    });

    it('should block requests with fetched rules', async () => {
      mockFetch(async () => ({
        ok: true,
        json: async () => fixtureRules
      }));

      const mw = await protect({ token: 'test-token', logging: false });
      const req = createReq({ query: { search: '1 UNION SELECT *' } });
      const res = createRes();
      let nextCalled = false;

      mw(req, res, () => { nextCalled = true; });

      assert.ok(!nextCalled);
      assert.strictEqual(res.statusCode, 403);
    });

    it('should fail open on API error', async () => {
      mockFetch(async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      }));

      const mw = await protect({ token: 'test-token' });
      const req = createReq({ query: { search: '1 UNION SELECT *' } });
      const res = createRes();
      let nextCalled = false;

      mw(req, res, () => { nextCalled = true; });

      assert.ok(nextCalled, 'Should pass through on API failure (fail-open)');
    });

    it('should fail open on network error', async () => {
      mockFetch(async () => {
        throw new Error('Network unreachable');
      });

      const mw = await protect({ token: 'test-token' });
      let nextCalled = false;

      mw(createReq(), createRes(), () => { nextCalled = true; });

      assert.ok(nextCalled, 'Should pass through on network error');
    });

    it('should call onScan callback', async () => {
      mockFetch(async () => ({
        ok: true,
        json: async () => fixtureRules
      }));

      let scanData = null;
      await protect({
        token: 'test-token',
        onScan: (data) => { scanData = data; }
      });

      assert.ok(scanData, 'onScan should have been called');
      assert.ok(Array.isArray(scanData.firewall));
    });

  });

  describe('protectSync()', () => {

    it('should return middleware immediately', () => {
      const mw = protectSync({ token: 'test-token' });
      assert.strictEqual(typeof mw, 'function');
    });

    it('should lazy-initialize on first request', async () => {
      mockFetch(async () => ({
        ok: true,
        json: async () => fixtureRules
      }));

      const mw = protectSync({ token: 'test-token' });
      const req = createReq();
      const res = createRes();

      await new Promise((resolve) => {
        mw(req, res, resolve);
      });
    });

    it('should fail open on init error', async () => {
      mockFetch(async () => {
        throw new Error('Connection refused');
      });

      const mw = protectSync({ token: 'test-token' });
      let nextCalled = false;

      await new Promise((resolve) => {
        mw(createReq(), createRes(), () => {
          nextCalled = true;
          resolve();
        });
      });

      assert.ok(nextCalled, 'Should pass through on init failure');
    });

  });

});
