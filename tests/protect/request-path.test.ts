import { describe, expect, it } from 'vitest';
import { RuleEngine } from '../../src/protect/engine/engine.js';
import { fromNodeRequest } from '../../src/protect/engine/node.js';
import { fromFetchRequest } from '../../src/protect/engine/fetch.js';
import { normalizeRequest, REQUEST_PATH, REQUEST_TARGET } from '../../src/protect/engine/normalizer.js';
import { RequestResolver } from '../../src/protect/engine/request.js';
import { validateBundle } from '../../src/protect/rules/validate.js';

function pathOf(req: any) {
  return new RequestResolver({ ...req, ...normalizeRequest(req) }).resolve('server.REQUEST_PATH');
}

const rule = {
  id: 'synthetic-path-rule',
  phase: 'request',
  action: 'block',
  when: { method: ['GET', 'DELETE'] },
  rule_v2: [{
    parameter: 'server.REQUEST_PATH',
    match: { type: 'regex', value: String.raw`/^\/api\/documents\/(?:\.\.[\/\\]|[\s\S]*[\/\\]\.\.[\/\\])/` },
  }],
};

describe('server.REQUEST_PATH', () => {
  it.each([
    ['/api/a?next=/../private', '/api/a'],
    ['/api/a%3Fb%2F..%2Fprivate?x=1', '/api/a?b/../private'],
    ['/api/a%23b%2F..%2Fprivate#ignored', '/api/a#b/../private'],
    ['/api/%252e%252e%252fprivate', '/api/%2e%2e%2fprivate'],
    ['/api/a+%2B%20b', '/api/a++ b'],
    ['/api/a%0A%00b', '/api/a\n\0b'],
    ['/api/a/*unchanged*/../b', '/api/a/*unchanged*/../b'],
    ['/api/&#46;&#46;/b', '/api/&'],
    ['/api/%26%2346%3B/b', '/api/&#46;/b'],
    ['//api/./a/../b\\c', '//api/./a/../b\\c'],
    ['https://app.test/api/a/../b?x=/../z', '/api/a/../b'],
    ['HTTP://app.test?x=1', '/'],
    ['https://app.test', '/'],
    ['/api/%E2%9C%93', '/api/✓'],
  ])('preserves path semantics for %s', (url, expected) => {
    expect(pathOf({ url })).toEqual([expected]);
  });

  it.each([undefined, '', '*', 'app.test:443', 'relative', '/bad%zz', '/bad%C0%AF', '/bad%E2'])
    ('does not fabricate a decoded path from %s', (url) => {
      expect(pathOf({ url })).toEqual([]);
    });

  it('uses the original target before mounted middleware rewrites the URL', () => {
    expect(pathOf({ originalUrl: '/mounted/a%3Fb?x=1', url: '/a%3Fb?x=1' })).toEqual(['/mounted/a?b']);
    expect(pathOf(fromNodeRequest({ originalUrl: '/mounted/a%3Fb?x=1', url: '/a%3Fb?x=1' })))
      .toEqual(['/mounted/a?b']);
  });

  it('ignores inherited evidence and overwrites a supplied derived path', () => {
    const req = Object.create({ url: '/fake', originalUrl: '/fake', [REQUEST_TARGET]: '/fake', [REQUEST_PATH]: '/fake' });
    expect(pathOf(req)).toEqual([]);
    expect(pathOf({ url: '/real', [REQUEST_PATH]: '/fake' })).toEqual(['/real']);
  });

  it('preserves raw Node dot segments without changing the legacy URI adapter', () => {
    const req = fromNodeRequest({ url: '/api/a/../b?x=1' });
    expect(req.originalUrl).toBe('/api/b?x=1');
    expect(pathOf(req)).toEqual(['/api/a/../b']);
  });

  it('leaves legacy REQUEST_URI normalization unchanged', () => {
    const req = normalizeRequest({ url: '/api/a%253Fb%2F..%2Fprivate?x=1' });
    expect(new RequestResolver(req).resolve('server.REQUEST_URI')).toEqual(['/api/a?b/../private?x=1']);
    expect(new RequestResolver(req).resolve('server.REQUEST_PATH')).toEqual(['/api/a%3Fb/../private']);
  });

  it('accepts the source in delivered bundles', () => {
    expect(validateBundle({ firewall: [rule] }).rejected).toEqual([]);
  });

  it.each([
    ['/api/documents/..%2Fprivate', true],
    ['/api/documents/a%3Fb%2F..%2F..%2Fprivate', true],
    ['/api/documents/a%23b%2F..%2F..%2Fprivate', true],
    ['/api/documents/a%0Ab%2F..%2Fprivate', true],
    ['/api/documents/a%5C..%5Cprivate', true],
    ['/api/documents/a%2F*b%2F..%2Fc*%2Fd', true],
    ['/api/documents/safe?next=/../private', false],
    ['/api/documents/safe?next=%2F..%2Fprivate', false],
    ['/api/documents/%252e%252e%252fprivate', false],
    ['/other/a%2F..%2Fprivate', false],
    ['/api/documents/safe', false],
  ])('evaluates %s consistently through direct, Node and Fetch adapters', async (url, blocked) => {
    const engine = new RuleEngine({ firewall: [rule] });
    const requests = [
      { method: 'GET', url },
      fromNodeRequest({ method: 'GET', url }),
      await fromFetchRequest(new Request(`https://app.test${url}`)),
    ];
    for (const req of requests) expect(engine.evaluate(req).blocked).toBe(blocked);
  });

  it('keeps the method constraint and recognizes DELETE', () => {
    const engine = new RuleEngine({ firewall: [rule] });
    const url = '/api/documents/..%2Fprivate';
    expect(engine.evaluate({ method: 'DELETE', url }).blocked).toBe(true);
    expect(engine.evaluate({ method: 'POST', url }).blocked).toBe(false);
  });

  it('uses only what Fetch exposes, without claiming to recover earlier canonicalization', async () => {
    const req = await fromFetchRequest(new Request('https://app.test/api/a/../b'));
    expect(pathOf(req)).toEqual(['/api/b']);
  });
});
