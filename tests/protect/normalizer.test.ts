import { describe, it } from 'vitest';
import assert from 'node:assert';
import {
    normalize,
    urlDecode,
    htmlEntityDecode,
    removeSqlComments,
    removeNullBytes,
    normalizeWhitespace,
    normalizeRequest,
    normalizeObject,
    createMatchVariants,
    _testExports
} from '../../src/protect/engine/normalizer.js';

describe('Normalizer Module', () => {

    describe('urlDecode', () => {

        it('should decode basic URL-encoded characters', () => {
            const result = urlDecode('hello%20world');
            assert.strictEqual(result, 'hello world');
        });

        it('should decode SQL injection payloads', () => {
            const result = urlDecode('1%20UNION%20SELECT%20*%20FROM%20users');
            assert.strictEqual(result, '1 UNION SELECT * FROM users');
        });

        it('should handle double encoding', () => {
            const result = urlDecode('%2520');
            assert.strictEqual(result, ' ');
        });

        it('should decode special characters', () => {
            const result = urlDecode('%3C%3E%22%27');
            assert.strictEqual(result, '<>"\'');
        });

        it('should handle already decoded strings', () => {
            const result = urlDecode('hello world');
            assert.strictEqual(result, 'hello world');
        });

        it('should handle malformed sequences gracefully', () => {
            const result = urlDecode('hello%GGworld%20test');
            assert.ok(result.includes('hello'));
            assert.ok(result.includes('test'));
        });

        it('should limit decode iterations to prevent infinite loops', () => {
            const result = urlDecode('%252525252520');
            assert.ok(typeof result === 'string');
        });

        it('should return non-strings unchanged', () => {
            assert.strictEqual(urlDecode(123), 123);
            assert.strictEqual(urlDecode(null), null);
            assert.deepStrictEqual(urlDecode({ a: 1 }), { a: 1 });
        });

    });

    describe('htmlEntityDecode', () => {

        it('should decode named HTML entities', () => {
            assert.strictEqual(htmlEntityDecode('&lt;script&gt;'), '<script>');
            assert.strictEqual(htmlEntityDecode('&amp;'), '&');
            assert.strictEqual(htmlEntityDecode('&quot;'), '"');
        });

        it('should decode decimal numeric entities', () => {
            assert.strictEqual(htmlEntityDecode('&#60;'), '<');
            assert.strictEqual(htmlEntityDecode('&#62;'), '>');
            assert.strictEqual(htmlEntityDecode('&#38;'), '&');
        });

        it('should decode hexadecimal numeric entities', () => {
            assert.strictEqual(htmlEntityDecode('&#x3C;'), '<');
            assert.strictEqual(htmlEntityDecode('&#x3E;'), '>');
            assert.strictEqual(htmlEntityDecode('&#x27;'), "'");
        });

        it('should handle mixed content', () => {
            const result = htmlEntityDecode('&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;');
            assert.strictEqual(result, '<img src="x" onerror="alert(1)">');
        });

        it('should return non-strings unchanged', () => {
            assert.strictEqual(htmlEntityDecode(123), 123);
            assert.strictEqual(htmlEntityDecode(null), null);
        });

    });

    describe('removeSqlComments', () => {

        it('should remove /* */ style comments', () => {
            const result = removeSqlComments('SELECT/*comment*/FROM users');
            assert.strictEqual(result, 'SELECT FROM users');
        });

        it('should remove /**/ style comments used for bypass', () => {
            const result = removeSqlComments('1/**/UNION/**/SELECT');
            assert.strictEqual(result, '1 UNION SELECT');
        });

        it('should remove -- style comments', () => {
            const result = removeSqlComments("SELECT * FROM users--comment\nWHERE id=1");
            assert.ok(result.includes('SELECT * FROM users'));
            assert.ok(!result.includes('comment'));
        });

        it('should remove # style comments (MySQL)', () => {
            const result = removeSqlComments("SELECT * FROM users#comment\nWHERE id=1");
            assert.ok(result.includes('SELECT * FROM users'));
            assert.ok(!result.includes('comment'));
        });

        it('should handle MySQL /*!...*/ comments', () => {
            const result = removeSqlComments('SELECT /*!50000 1*/');
            assert.strictEqual(result.trim(), 'SELECT');
        });

        it('should handle multiple comments', () => {
            const result = removeSqlComments('/*a*/SELECT/*b*/FROM/*c*/');
            assert.strictEqual(result.trim(), 'SELECT FROM');
        });

        it('should return non-strings unchanged', () => {
            assert.strictEqual(removeSqlComments(123), 123);
            assert.strictEqual(removeSqlComments(null), null);
        });

    });

    describe('removeNullBytes', () => {

        it('should remove null bytes', () => {
            const result = removeNullBytes('hello\x00world');
            assert.strictEqual(result, 'helloworld');
        });

        it('should remove other control characters', () => {
            const result = removeNullBytes('hello\x01\x02world');
            assert.strictEqual(result, 'helloworld');
        });

        it('should preserve tabs and newlines', () => {
            const result = removeNullBytes('hello\tworld\n');
            assert.strictEqual(result, 'hello\tworld\n');
        });

        it('should return non-strings unchanged', () => {
            assert.strictEqual(removeNullBytes(123), 123);
            assert.strictEqual(removeNullBytes(null), null);
        });

    });

    describe('normalizeWhitespace', () => {

        it('should collapse multiple spaces', () => {
            const result = normalizeWhitespace('hello    world');
            assert.strictEqual(result, 'hello world');
        });

        it('should replace tabs with spaces', () => {
            const result = normalizeWhitespace('hello\tworld');
            assert.strictEqual(result, 'hello world');
        });

        it('should replace newlines with spaces', () => {
            const result = normalizeWhitespace('hello\nworld');
            assert.strictEqual(result, 'hello world');
        });

        it('should handle mixed whitespace', () => {
            const result = normalizeWhitespace('hello\t\n\r  world');
            assert.strictEqual(result, 'hello world');
        });

        it('should return non-strings unchanged', () => {
            assert.strictEqual(normalizeWhitespace(123), 123);
            assert.strictEqual(normalizeWhitespace(null), null);
        });

    });

    describe('normalize (full pipeline)', () => {

        it('should apply all normalizations by default', () => {
            const input = 'hello%20world\x00/*comment*/';
            const result = normalize(input);
            assert.ok(!result.includes('%20'));
            assert.ok(!result.includes('\x00'));
            assert.ok(!result.includes('comment'));
        });

        it('should decode URL-encoded SQL injection', () => {
            const result = normalize('1%20UNION%20SELECT%20*%20FROM%20users');
            assert.strictEqual(result, '1 UNION SELECT * FROM users');
        });

        it('should handle combined encoding bypass attempts', () => {
            const result = normalize('1%2F%2A%2A%2FUNION%2F%2A%2A%2FSELECT');
            assert.ok(result.includes('UNION'));
            assert.ok(result.includes('SELECT'));
        });

        it('should allow selective normalization', () => {
            const input = 'hello%20world/*comment*/';

            const withoutSql = normalize(input, { sqlComments: false });
            assert.ok(withoutSql.includes('/*comment*/'));

            const withoutUrl = normalize(input, { urlDecode: false });
            assert.ok(withoutUrl.includes('%20'));
        });

        it('should handle XSS payload normalization', () => {
            const result = normalize('&lt;script&gt;alert%28%27xss%27%29&lt;/script&gt;');
            assert.ok(result.includes('<script>'));
            assert.ok(result.includes('alert'));
        });

    });

    describe('normalizeObject', () => {

        it('should normalize string values', () => {
            const result = normalizeObject('hello%20world');
            assert.strictEqual(result, 'hello world');
        });

        it('should recursively normalize object properties', () => {
            const result = normalizeObject({
                name: 'hello%20world',
                nested: { value: '%3Cscript%3E' }
            });
            assert.strictEqual(result.name, 'hello world');
            assert.strictEqual(result.nested.value, '<script>');
        });

        it('should normalize arrays', () => {
            const result = normalizeObject(['hello%20', 'world%21']);
            assert.deepStrictEqual(result, ['hello ', 'world!']);
        });

        it('should pass through non-string primitives', () => {
            const result = normalizeObject({ num: 123, bool: true, nil: null });
            assert.strictEqual(result.num, 123);
            assert.strictEqual(result.bool, true);
            assert.strictEqual(result.nil, null);
        });

    });

    describe('normalizeRequest', () => {

        it('should normalize all request components', () => {
            const req = {
                query: { search: 'hello%20world' },
                body: { data: '%3Cscript%3E' },
                headers: { 'x-custom': 'test%20header' },
                url: '/api?q=hello%20world'
            };

            const result = normalizeRequest(req);
            assert.strictEqual(result.query.search, 'hello world');
            assert.strictEqual(result.body.data, '<script>');
            assert.strictEqual(result.headers['x-custom'], 'test header');
            assert.ok(result.url.includes('hello world'));
        });

        it('should handle missing request properties', () => {
            const result = normalizeRequest({});
            assert.deepStrictEqual(result.query, {});
            assert.deepStrictEqual(result.body, {});
            assert.deepStrictEqual(result.headers, {});
        });

        it('should set _rawBody to original string body before normalization', () => {
            const req = {
                body: '{"__proto__":{"admin":true}}'
            };
            const result = normalizeRequest(req);
            assert.strictEqual(result._rawBody, '{"__proto__":{"admin":true}}');
        });

        it('should set _rawBody from object body using getOwnPropertyNames serialization', () => {
            const obj = {};
            Object.defineProperty(obj, '__proto__', {
                value: { admin: true },
                enumerable: true,
                configurable: true,
                writable: true
            });
            const result = normalizeRequest({ body: obj });
            assert.ok(typeof result._rawBody === 'string');
            assert.ok(result._rawBody.includes('__proto__'), `Expected __proto__ in _rawBody: ${result._rawBody}`);
        });

        it('should set _rawBody to empty string when body is missing', () => {
            const result = normalizeRequest({});
            assert.strictEqual(result._rawBody, '');
        });

        it('should still normalize query, body, headers, url, originalUrl', () => {
            const req = {
                query: { q: 'hello%20world' },
                body: '{"data":"%3Cscript%3E"}',
                headers: { 'x-test': 'val%21' },
                url: '/path?q=hello%20world'
            };
            const result = normalizeRequest(req);
            assert.strictEqual(result.query.q, 'hello world');
            assert.ok(result.body.includes('<script>'), 'normalized body should contain decoded <script>');
            assert.ok(!result.body.includes('%3C'), 'normalized body should not contain URL-encoded %3C');
            assert.strictEqual(result.headers['x-test'], 'val!');
            assert.ok(result.url.includes('hello world'));
        });

        it('should preserve original URL-encoded string in _rawBody (not normalized)', () => {
            // URL-encoded {"__proto__":{"admin":true}} — _rawBody should keep the raw form
            const raw = '%7B%22__proto__%22%3A%7B%22admin%22%3Atrue%7D%7D';
            const result = normalizeRequest({ body: raw });
            // _rawBody must be the original (un-decoded) string, not the normalized version
            assert.strictEqual(result._rawBody, raw, '_rawBody should preserve original encoded string');
            // body itself gets normalized (URL-decoded)
            assert.ok(result.body.includes('__proto__'), 'normalized body should contain __proto__');
            assert.ok(!result.body.includes('%7B'), 'normalized body should be URL-decoded');
        });

    });

    describe('createMatchVariants', () => {

        it('should return original value', () => {
            const variants = createMatchVariants('hello');
            assert.ok(variants.includes('hello'));
        });

        it('should include URL decoded variant', () => {
            const variants = createMatchVariants('hello%20world');
            assert.ok(variants.includes('hello world'));
        });

        it('should include lowercase variants', () => {
            const variants = createMatchVariants('HELLO');
            assert.ok(variants.includes('hello'));
        });

        it('should not create duplicates', () => {
            const variants = createMatchVariants('hello');
            const unique = new Set(variants);
            assert.strictEqual(variants.length, unique.size);
        });

        it('should return single-element array for non-strings', () => {
            const variants = createMatchVariants(123);
            assert.deepStrictEqual(variants, [123]);
        });

    });

    describe('Bypass Prevention Tests', () => {

        it('should detect URL-encoded SQL injection', () => {
            const payload = '1%20UNION%20SELECT%20*%20FROM%20users';
            const normalized = normalize(payload);
            assert.ok(/UNION\s+SELECT/i.test(normalized));
        });

        it('should detect double-encoded SQL injection', () => {
            const payload = '1%2520UNION%2520SELECT';
            const normalized = normalize(payload);
            assert.ok(normalized.includes('UNION'));
        });

        it('should detect SQL injection with comments', () => {
            const payload = '1/**/UNION/**/SELECT';
            const normalized = normalize(payload);
            assert.ok(/UNION\s+SELECT/i.test(normalized));
        });

        it('should detect XSS with HTML entities', () => {
            const payload = '&lt;script&gt;alert(1)&lt;/script&gt;';
            const normalized = normalize(payload);
            assert.ok(/<script>/i.test(normalized));
        });

        it('should detect null byte injection attempts', () => {
            const payload = 'test\x00.jpg';
            const normalized = normalize(payload);
            assert.strictEqual(normalized, 'test.jpg');
        });

        it('should handle combined obfuscation techniques', () => {
            const payload = '%3Cscript%3E/*comment*/alert%28%27xss%27%29%3C/script%3E';
            const normalized = normalize(payload);
            assert.ok(normalized.includes('<script>'));
            assert.ok(normalized.includes('alert'));
            assert.ok(!normalized.includes('%3C'));
        });

    });

    describe('serializeForRawDetection', () => {

        it('should return string bodies unchanged', () => {
            const { serializeForRawDetection } = _testExports;
            assert.strictEqual(serializeForRawDetection('{"__proto__":{"admin":true}}'), '{"__proto__":{"admin":true}}');
        });

        it('should return empty string for null/undefined', () => {
            const { serializeForRawDetection } = _testExports;
            assert.strictEqual(serializeForRawDetection(null), '');
            assert.strictEqual(serializeForRawDetection(undefined), '');
        });

        it('should serialize plain objects including own properties', () => {
            const { serializeForRawDetection } = _testExports;
            const obj = { a: 1, b: 'hello' };
            const result = serializeForRawDetection(obj);
            assert.ok(result.includes('"a"'));
            assert.ok(result.includes('"b"'));
        });

        it('should detect __proto__ defined as own property via Object.defineProperty', () => {
            const { serializeForRawDetection } = _testExports;
            const obj = Object.create(null);
            Object.defineProperty(obj, '__proto__', {
                value: { admin: true },
                enumerable: true,
                configurable: true,
                writable: true
            });
            const result = serializeForRawDetection(obj);
            assert.ok(result.includes('__proto__'), `Expected __proto__ in: ${result}`);
        });

        it('should handle nested objects', () => {
            const { serializeForRawDetection } = _testExports;
            const obj = { outer: { inner: 'value' } };
            const result = serializeForRawDetection(obj);
            assert.ok(result.includes('"inner"'));
            assert.ok(result.includes('"value"'));
        });

        it('should handle arrays', () => {
            const { serializeForRawDetection } = _testExports;
            const result = serializeForRawDetection([1, 'two', { three: 3 }]);
            assert.ok(result.includes('"three"'));
        });

        it('should handle circular references without throwing', () => {
            const { serializeForRawDetection } = _testExports;
            const obj = { a: 1 };
            obj.self = obj;
            let result;
            assert.doesNotThrow(() => { result = serializeForRawDetection(obj); });
            assert.ok(typeof result === 'string', 'result should be a string');
            assert.ok(result.includes('Circular'), `Expected Circular marker in: ${result}`);
        });

    });

});
