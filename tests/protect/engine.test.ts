import { describe, it } from 'vitest';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleEngine, _testExports } from '../../src/protect/engine/engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRules = JSON.parse(
  await readFile(join(__dirname, 'fixtures', 'rules-response.json'), 'utf-8')
);

const { matchValue, safeRegExp } = _testExports;

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

describe('RuleEngine', () => {

  describe('matchValue', () => {

    it('should match equals (loose)', () => {
      assert.strictEqual(matchValue('equals', '1', 1), true);
      assert.strictEqual(matchValue('equals', 'hello', 'hello'), true);
      assert.strictEqual(matchValue('equals', 'hello', 'world'), false);
    });

    it('should match equals_strict', () => {
      assert.strictEqual(matchValue('equals_strict', '1', '1'), true);
      assert.strictEqual(matchValue('equals_strict', '1', 1), false);
    });

    it('should match contains (case-insensitive)', () => {
      assert.strictEqual(matchValue('contains', 'Hello World', 'hello'), true);
      assert.strictEqual(matchValue('contains', 'test', 'xyz'), false);
    });

    it('should match not_contains', () => {
      assert.strictEqual(matchValue('not_contains', 'hello', 'xyz'), true);
      assert.strictEqual(matchValue('not_contains', 'hello', 'ell'), false);
    });

    it('should match regex', () => {
      assert.strictEqual(matchValue('regex', 'UNION SELECT', '/union\\s+select/i'), true);
      assert.strictEqual(matchValue('regex', 'normal query', '/union\\s+select/i'), false);
    });

    it('should match more_than', () => {
      assert.strictEqual(matchValue('more_than', '10', 5), true);
      assert.strictEqual(matchValue('more_than', '3', 5), false);
    });

    it('should match less_than', () => {
      assert.strictEqual(matchValue('less_than', '3', 5), true);
      assert.strictEqual(matchValue('less_than', '10', 5), false);
    });

    it('should match ctype_digit', () => {
      assert.strictEqual(matchValue('ctype_digit', '12345', null), true);
      assert.strictEqual(matchValue('ctype_digit', '123abc', null), false);
    });

    it('should honor the value inversion for ctype_* (value:false = flag when NOT of class)', () => {
      // The canonical vPatch shape: `{ type: 'ctype_digit', value: false }` must FLAG a
      // non-numeric value and PASS a numeric one — previously the matchVal was ignored,
      // which inverted the rule (blocking legit numeric IDs, passing injection).
      assert.strictEqual(matchValue('ctype_digit', '123abc', false), true, 'non-numeric should match value:false');
      assert.strictEqual(matchValue('ctype_digit', '12345', false), false, 'numeric should not match value:false');
      assert.strictEqual(matchValue('ctype_alnum', 'a b;drop', false), true, 'special chars match value:false');
      assert.strictEqual(matchValue('ctype_alnum', 'abc123', false), false, 'alnum should not match value:false');
    });

    it('should not match ctype_*/is_numeric on empty or absent values', () => {
      // engine-php skips empty (`$value != ''`); otherwise every missing param would
      // false-positive a `value:false` rule.
      assert.strictEqual(matchValue('ctype_digit', '', false), false);
      assert.strictEqual(matchValue('ctype_alnum', '', false), false);
      assert.strictEqual(matchValue('is_numeric', '', false), false);
      assert.strictEqual(matchValue('ctype_digit', null, false), false);
    });

    it('should match is_numeric', () => {
      assert.strictEqual(matchValue('is_numeric', '3.14', null), true);
      assert.strictEqual(matchValue('is_numeric', 'abc', null), false);
      assert.strictEqual(matchValue('is_numeric', '', null), false);
    });

    it('should match isset', () => {
      assert.strictEqual(matchValue('isset', 'anything', null), true);
      assert.strictEqual(matchValue('isset', null, null), false);
    });

    it('should match in_array', () => {
      assert.strictEqual(matchValue('in_array', 'b', ['a', 'b', 'c']), true);
      assert.strictEqual(matchValue('in_array', 'x', ['a', 'b', 'c']), false);
    });

    it('should match not_in_array', () => {
      assert.strictEqual(matchValue('not_in_array', 'x', ['a', 'b']), true);
      assert.strictEqual(matchValue('not_in_array', 'a', ['a', 'b']), false);
    });

    it('should match hostname', () => {
      assert.strictEqual(matchValue('hostname', 'https://example.com/path', 'example.com'), true);
      assert.strictEqual(matchValue('hostname', 'https://other.com/path', 'example.com'), false);
    });

    it('should match internal_host (SSRF egress ranges)', () => {
      for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '192.168.1.1', '172.16.0.1', 'localhost', 'metadata.google.internal', '::1']) {
        assert.strictEqual(matchValue('internal_host', host, null), true, `${host} should be internal`);
      }
      for (const host of ['example.com', '8.8.8.8', '1.1.1.1', '172.32.0.1']) {
        assert.strictEqual(matchValue('internal_host', host, null), false, `${host} should be external`);
      }
    });

    it('should match internal_host when the value is a URL, not a bare host', () => {
      // The gap this closes: `internal_host` was written for the egress phase, where the value IS the
      // destination host. On the request phase the same question arrives as an application parameter and
      // the value is a full URL — so a served, correctly-pinned SSRF rule matched nothing at all.
      for (const value of [
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost:3000/admin',
        'https://127.0.0.1/x',
        'http://[::1]/x',
        'http://metadata.google.internal/computeMetadata/v1/',
        '//10.0.0.5/x',
        '169.254.169.254:80',
        '[::1]:8080',
      ]) {
        assert.strictEqual(matchValue('internal_host', value, null), true, `${value} should be internal`);
      }

      for (const value of [
        'https://api.stripe.example/v1/charges',
        'http://8.8.8.8/resolve',
        'how to use localhost in docker',
        'https://example.com/?next=/admin',
      ]) {
        assert.strictEqual(matchValue('internal_host', value, null), false, `${value} should be external`);
      }
    });

    it('should read the host a URL actually contacts, not the one it advertises', () => {
      // Why the host is parsed rather than sliced out of the string. Userinfo puts a trusted-looking name
      // before the real host, and a fragment puts one after it; a substring check reads the wrong one in
      // both directions, which is a bypass in the first case and a false positive in the second.
      assert.strictEqual(matchValue('internal_host', 'http://api.stripe.example@169.254.169.254/', null), true);
      assert.strictEqual(matchValue('internal_host', 'http://evil.example/#@127.0.0.1', null), false);
      assert.strictEqual(matchValue('internal_host', 'http://evil.example/?next=http://127.0.0.1/', null), false);
    });

    it('should leave a bare host classified exactly as before', () => {
      // The egress path and the built-in default rule pass `egress.host`, which is already a hostname.
      // Extraction must be a no-op for those, or this change would alter what a live guard blocks today.
      assert.strictEqual(matchValue('internal_host', '169.254.169.254', null), true);
      assert.strictEqual(matchValue('internal_host', '::1', null), true);
      assert.strictEqual(matchValue('internal_host', '2130706433', null), true); // decimal 127.0.0.1
      assert.strictEqual(matchValue('internal_host', 'example.com', null), false);
      assert.strictEqual(matchValue('internal_host', '', null), false);
    });

    it('should match quotes (and the inline_js_xss alias)', () => {
      assert.strictEqual(matchValue('quotes', `x' OR 1=1`, null), true);
      assert.strictEqual(matchValue('quotes', 'no quotes here', null), false);
      assert.strictEqual(matchValue('inline_js_xss', 'say "hi"', null), true);
    });

    it('should match inline_xss (quote AND > or =)', () => {
      assert.strictEqual(matchValue('inline_xss', `" onmouseover=alert(1)`, null), true);
      assert.strictEqual(matchValue('inline_xss', `"><script>`, null), true);
      assert.strictEqual(matchValue('inline_xss', `just "quoted" text`, null), false); // quote but no >/=
    });

    it('should match stripos as an alias of contains', () => {
      assert.strictEqual(matchValue('stripos', 'Hello World', 'world'), true);
      assert.strictEqual(matchValue('stripos', 'Hello World', 'xyz'), false);
    });

    it('should match ctype_special (strips space/_/-/, then alnum, honors value)', () => {
      // legitimate column-ish name with separators is "clean" -> does NOT match value:false
      assert.strictEqual(matchValue('ctype_special', 'date_created', false), false);
      // SQL metacharacters survive stripping -> NOT clean -> matches value:false
      assert.strictEqual(matchValue('ctype_special', '1) OR SLEEP(5', false), true);
      assert.strictEqual(matchValue('ctype_special', '', false), false); // empty skipped
    });

    it('should match array_key_value (navigate key, run nested match)', () => {
      const obj = { user: { role: 'administrator' }, id: '5' };
      assert.strictEqual(
        matchValue('array_key_value', obj, undefined, {
          type: 'array_key_value',
          key: 'user.role',
          match: { type: 'equals', value: 'administrator' }
        }),
        true
      );
      assert.strictEqual(
        matchValue('array_key_value', obj, undefined, {
          type: 'array_key_value',
          key: 'user.role',
          match: { type: 'equals', value: 'subscriber' }
        }),
        false
      );
      // missing key -> no match
      assert.strictEqual(
        matchValue('array_key_value', obj, undefined, {
          type: 'array_key_value',
          key: 'user.missing',
          match: { type: 'isset' }
        }),
        false
      );
    });

    it('removed WordPress-only types never match and are reported (not silent)', () => {
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (msg) => warnings.push(String(msg));
      try {
        assert.strictEqual(matchValue('current_user_cannot', 'val', 'val'), false);
        assert.strictEqual(matchValue('general_xss', 'val', 'val'), false);
        assert.strictEqual(matchValue('getShortcodeAtts', 'val', 'val'), false);
        assert.strictEqual(matchValue('getBlockAtts', 'val', 'val'), false);
      } finally {
        console.warn = originalWarn;
      }
      assert.ok(
        warnings.some((w) => w.includes('current_user_cannot')),
        'a removed WP type should emit a warning rather than pass silently'
      );
    });

    it('file_contains is unimplemented and returns false', () => {
      assert.strictEqual(matchValue('file_contains', 'val', 'val'), false);
    });

    it('should return false for unknown match type', () => {
      assert.strictEqual(matchValue('nonexistent', 'val', 'val'), false);
    });

    it('should return false for null value (except isset)', () => {
      assert.strictEqual(matchValue('contains', null, 'test'), false);
      assert.strictEqual(matchValue('equals', null, 'test'), false);
    });

  });

  describe('safeRegExp', () => {

    it('should parse valid regex', () => {
      const re = safeRegExp('/test/i');
      assert.ok(re instanceof RegExp);
      assert.ok(re.test('TEST'));
    });

    it('should return null for dangerous patterns', () => {
      assert.strictEqual(safeRegExp('/(a+)+/'), null);
      assert.strictEqual(safeRegExp('/(a*)+/'), null);
    });

    it('should return null for invalid regex', () => {
      assert.strictEqual(safeRegExp('/[invalid/'), null);
    });

    it('should return null for non-regex string', () => {
      assert.strictEqual(safeRegExp('plain string'), null);
    });

    it('should return null for empty input', () => {
      assert.strictEqual(safeRegExp(''), null);
      assert.strictEqual(safeRegExp(null), null);
    });

  });

  describe('evaluate()', () => {

    it('should block SQL injection in query', () => {
      const engine = new RuleEngine(fixtureRules);
      const req = createReq({ query: { search: '1 UNION SELECT * FROM users' } });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true);
      assert.strictEqual(result.rule.id, 101);
    });

    it('should block XSS in body', () => {
      const engine = new RuleEngine(fixtureRules);
      const req = createReq({
        method: 'POST',
        body: { comment: '<script>alert(1)</script>' }
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true);
      assert.strictEqual(result.rule.id, 102);
    });

    it('should block path traversal in URI', () => {
      const engine = new RuleEngine(fixtureRules);
      const req = createReq({
        url: '/files/../../../etc/passwd',
        originalUrl: '/files/../../../etc/passwd'
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true);
      assert.strictEqual(result.rule.id, 104);
    });

    it('should block prototype pollution in raw body', () => {
      const engine = new RuleEngine(fixtureRules);
      const req = createReq({
        body: '{"__proto__":{"admin":true}}'
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true);
      assert.strictEqual(result.rule.id, 105);
    });

    it('should block SSRF to internal IPs', () => {
      const engine = new RuleEngine(fixtureRules);
      const req = createReq({
        method: 'POST',
        body: { url: 'http://127.0.0.1/admin' }
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true);
      assert.strictEqual(result.rule.id, 106);
    });

    it('should block base64-encoded payloads with mutations', () => {
      const engine = new RuleEngine(fixtureRules);
      const encoded = Buffer.from('<script>alert(1)</script>').toString('base64');
      const req = createReq({
        method: 'POST',
        body: { data: encoded }
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true);
      assert.strictEqual(result.rule.id, 107);
    });

    it('should block malicious user-agent', () => {
      const engine = new RuleEngine(fixtureRules);
      const req = createReq({
        headers: { 'user-agent': 'sqlmap/1.5' }
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true);
      assert.strictEqual(result.rule.id, 108);
    });

    it('should allow clean requests', () => {
      const engine = new RuleEngine(fixtureRules);
      const req = createReq({ query: { search: 'normal search term' } });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, false);
      assert.strictEqual(result.rule, null);
    });

    it('should handle empty rules', () => {
      const engine = new RuleEngine({ firewall: [] });
      const result = engine.evaluate(createReq());

      assert.strictEqual(result.blocked, false);
    });

    it('resolves array parameters (["get.x","post.x"]) as OR across sources', () => {
      const engine = new RuleEngine({
        firewall: [{ id: 'a', rule_v2: [{ parameter: ['get.x', 'post.x'], match: { type: 'contains', value: 'bad' } }] }]
      });
      assert.strictEqual(engine.evaluate(createReq({ query: { x: 'bad' } })).blocked, true, 'matches via get');
      assert.strictEqual(engine.evaluate(createReq({ query: {}, body: { x: 'bad' } })).blocked, true, 'matches via post');
      assert.strictEqual(engine.evaluate(createReq({ query: { x: 'ok' } })).blocked, false, 'no match');
    });

  });

  describe('fail open', () => {
    // A rule whose evaluation throws (here: a getter that blows up).
    const throwingRule = {
      id: 'bad',
      get rule_v2() {
        throw new Error('boom');
      }
    };

    it('skips a throwing rule, allows the request, and reports the error', () => {
      const errors = [];
      const engine = new RuleEngine({ firewall: [throwingRule], onError: (e) => errors.push(e) });

      const result = engine.evaluate(createReq({ query: { x: '1' } }));

      assert.strictEqual(result.blocked, false); // fail open — never throws, never blocks
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0].message, /boom/);
    });

    it('a throwing rule does not shadow a later rule that matches', () => {
      const good = {
        id: 'good',
        title: 'x',
        rule_v2: [{ parameter: 'get.x', match: { type: 'isset' } }]
      };
      const engine = new RuleEngine({ firewall: [throwingRule, good], onError: () => {} });

      const result = engine.evaluate(createReq({ query: { x: '1' } }));

      assert.strictEqual(result.blocked, true);
      assert.strictEqual(result.rule.id, 'good');
    });

    it('evaluate() never throws even without an onError handler', () => {
      const engine = new RuleEngine({ firewall: [throwingRule] });
      // Suppress the default console.error for this assertion.
      const originalError = console.error;
      console.error = () => {};
      try {
        assert.doesNotThrow(() => engine.evaluate(createReq()));
      } finally {
        console.error = originalError;
      }
    });
  });

  describe('inclusive (AND) logic', () => {

    it('should require ALL inclusive conditions to match', () => {
      const engine = new RuleEngine(fixtureRules);

      // Rule 103 requires BOTH: post.action=delete_all_users AND REQUEST_METHOD=POST
      const req = createReq({
        method: 'POST',
        body: { action: 'delete_all_users' }
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true);
      assert.strictEqual(result.rule.id, 103);
    });

    it('should not block when only one inclusive condition matches', () => {
      const engine = new RuleEngine({
        firewall: [{
          id: 200,
          title: 'Test AND rule',
          rule_v2: [
            { parameter: 'post.action', match: { type: 'equals', value: 'delete_all' }, inclusive: true },
            { parameter: 'post.confirm', match: { type: 'equals', value: 'yes' }, inclusive: true }
          ]
        }]
      });

      // Only action matches, confirm is missing
      const req = createReq({
        method: 'POST',
        body: { action: 'delete_all' }
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, false);
    });

    it('should block when all inclusive conditions match', () => {
      const engine = new RuleEngine({
        firewall: [{
          id: 200,
          title: 'Test AND rule',
          rule_v2: [
            { parameter: 'post.action', match: { type: 'equals', value: 'delete_all' }, inclusive: true },
            { parameter: 'post.confirm', match: { type: 'equals', value: 'yes' }, inclusive: true }
          ]
        }]
      });

      const req = createReq({
        method: 'POST',
        body: { action: 'delete_all', confirm: 'yes' }
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true);
    });

  });

  describe('whitelists', () => {

    it('should not block whitelisted requests', () => {
      const engine = new RuleEngine(fixtureRules);

      // Rule 101 blocks SQL injection in search, but whitelist allows IP 10.0.0.1
      const req = createReq({
        query: { search: '1 UNION SELECT * FROM users' },
        ip: '10.0.0.1'
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, false);
    });

    it('should block non-whitelisted requests', () => {
      const engine = new RuleEngine(fixtureRules);

      const req = createReq({
        query: { search: '1 UNION SELECT * FROM users' },
        ip: '192.168.1.1'
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true);
    });

  });

  describe('nested rules', () => {

    it('should evaluate nested rule conditions', () => {
      const engine = new RuleEngine({
        firewall: [{
          id: 300,
          title: 'Nested rule test',
          rule_v2: [
            {
              parameter: 'rules',
              match: { type: 'equals', value: '' },
              inclusive: false,
              rules: [
                {
                  parameter: 'post.action',
                  match: { type: 'equals', value: 'exploit' },
                  inclusive: true
                },
                {
                  parameter: 'post.target',
                  match: { type: 'contains', value: 'admin' },
                  inclusive: true
                }
              ]
            }
          ]
        }]
      });

      const req = createReq({
        method: 'POST',
        body: { action: 'exploit', target: 'admin_panel' }
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true);
    });

  });

  describe('URL-encoded bypass regression tests', () => {

    it('should block URL-encoded SQL injection (normalization enforced)', () => {
      const engine = new RuleEngine(fixtureRules);
      // Without normalization, %20UNION%20SELECT bypasses the /union\s+select/i regex
      const req = createReq({ query: { search: '1%20UNION%20SELECT%20*%20FROM%20users' } });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true, 'URL-encoded SQLi should be caught after normalization');
      assert.strictEqual(result.rule.id, 101);
    });

    it('should block double-encoded SQL injection', () => {
      const engine = new RuleEngine(fixtureRules);
      const req = createReq({ query: { search: '1%2520UNION%2520SELECT' } });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true, 'Double-encoded SQLi should be caught');
      assert.strictEqual(result.rule.id, 101);
    });

    it('should block URL-encoded XSS in comment field', () => {
      const engine = new RuleEngine(fixtureRules);
      // %3Cscript%3E decodes to <script>
      const req = createReq({
        method: 'POST',
        body: { comment: '%3Cscript%3Ealert(1)%3C%2Fscript%3E' }
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true, 'URL-encoded XSS should be caught after normalization');
      assert.strictEqual(result.rule.id, 102);
    });

  });

  describe('Prototype pollution regression tests', () => {

    it('should block prototype pollution in raw string body (regression)', () => {
      const engine = new RuleEngine(fixtureRules);
      const req = createReq({
        body: '{"__proto__":{"admin":true}}'
      });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true, 'String body __proto__ should be detected');
      assert.strictEqual(result.rule.id, 105);
    });

    it('should block prototype pollution in parsed object body with __proto__ as own property', () => {
      const engine = new RuleEngine(fixtureRules);
      const body = Object.create(null);
      Object.defineProperty(body, '__proto__', {
        value: { admin: true },
        enumerable: true,
        configurable: true,
        writable: true
      });
      const req = createReq({ body });
      const result = engine.evaluate(req);

      assert.strictEqual(result.blocked, true, 'Parsed object __proto__ own property should be detected');
      assert.strictEqual(result.rule.id, 105);
    });

  });

});
