import { describe, expect, it } from 'vitest';
import { RuleEngine } from '../../src/protect/engine/engine.js';
import { RequestResolver } from '../../src/protect/engine/request.js';
import {
  decodeHtmlEntities, normalizeObject, normalizeRequest, safeUrlDecode, urlDecode,
} from '../../src/protect/engine/normalizer.js';
import { createProtection } from '../../src/protect/runtime.js';

// Every value below is synthetic. Each case pairs a request the rule must match with one it must not, so a
// decoder that matches everything fails as surely as one that matches nothing.

function request(overrides: Record<string, unknown> = {}) {
  return { method: 'GET', url: '/', originalUrl: '/', query: {}, body: {}, headers: {}, ...overrides };
}

function blocks(condition: object, req: object) {
  const engine = new RuleEngine({ firewall: [{ id: 1, title: 'sample', rule_v2: [condition] }] });
  return engine.evaluate(req).blocked;
}

async function guardBlocks(condition: object, req: Request) {
  const protection: any = await createProtection({
    mode: 'block',
    rules: { firewall: [{ id: 1, title: 'sample', rule_v2: [condition] }], whitelists: [], whitelist_keys: {} },
  });
  return (await protection.fetchGuard()(req)) !== null;
}

describe('percent-decoding beside a stray %', () => {
  it('decodes the escapes around a % that starts no escape', () => {
    expect(safeUrlDecode('100% %53AMPLE')).toBe('100% SAMPLE');
    expect(safeUrlDecode('%zz%41')).toBe('%zzA');
  });

  it('decodes multi-byte UTF-8 runs and replaces bytes that are not UTF-8', () => {
    expect(safeUrlDecode('50% caf%C3%A9')).toBe('50% café');
    expect(safeUrlDecode('%41%FF%42')).toBe('A�B');
  });

  it('keeps decoding repeated encodings when the value also holds a stray %', () => {
    expect(urlDecode('50% %253Csample%253E')).toBe('50% <sample>');
  });

  it('applies the urldecode mutation to a raw body containing a stray %', async () => {
    const condition = { parameter: 'raw', mutations: ['urldecode'], match: { type: 'contains', value: 'SAMPLE_TOKEN' } };
    const body = (text: string) => new Request('https://app.example.test/', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: text });
    expect(await guardBlocks(condition, body('100% %53AMPLE_TOKEN'))).toBe(true);
    expect(await guardBlocks(condition, body('100% %53AMPLE_OTHER'))).toBe(false);
  });
});

describe('+ in form and query data', () => {
  it('reads + as a space in the query of REQUEST_URI and all', () => {
    for (const parameter of ['server.REQUEST_URI', 'all']) {
      const condition = { parameter, match: { type: 'contains', value: 'sample value' } };
      expect(blocks(condition, request({ url: '/search?q=sample+value', originalUrl: '/search?q=sample+value' }))).toBe(true);
      expect(blocks(condition, request({ url: '/search?q=sample-value', originalUrl: '/search?q=sample-value' }))).toBe(false);
    }
  });

  it('reads + as a space in a request target given only as url', () => {
    const normalized = normalizeRequest({ url: '/search?q=sample+value&r=a%2Bb' });
    expect(normalized.url).toBe('/search?q=sample value&r=a+b');
    expect(normalized.originalUrl).toBe('/search?q=sample value&r=a+b');
    expect(normalizeRequest({ url: '/a+b?q=sample-value' }).url).toBe('/a+b?q=sample-value');
  });

  it('reads + as a space in url and originalUrl independently', () => {
    const normalized = normalizeRequest({ url: '/inner?q=first+value', originalUrl: '/outer?q=second+value' });
    expect(normalized.url).toBe('/inner?q=first value');
    expect(normalized.originalUrl).toBe('/outer?q=second value');
  });

  it('keeps an encoded + and a + in the path literal', () => {
    const literal = { parameter: 'server.REQUEST_URI', match: { type: 'contains', value: 'a+b' } };
    expect(blocks(literal, request({ originalUrl: '/search?q=a%2Bb' }))).toBe(true);
    expect(blocks(literal, request({ originalUrl: '/search?q=a+b' }))).toBe(false);
    expect(blocks(literal, request({ originalUrl: '/a+b?q=1' }))).toBe(true);
  });

  it('keeps path scoping on a + in the path', () => {
    const engine = new RuleEngine({
      firewall: [{ id: 1, title: 'sample', when: { path: '/a+b' }, rule_v2: [{ parameter: 'get.q', match: { type: 'isset' } }] }],
    });
    expect(engine.evaluate(request({ originalUrl: '/a+b?q=1', query: { q: '1' } })).blocked).toBe(true);
    expect(engine.evaluate(request({ originalUrl: '/a b?q=1', query: { q: '1' } })).blocked).toBe(false);
  });

  it('reads + as a space in the urldecode mutation', async () => {
    const condition = { parameter: 'raw', mutations: ['urldecode'], match: { type: 'contains', value: 'sample value' } };
    const form = (text: string) => new Request('https://app.example.test/', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: text,
    });
    expect(await guardBlocks(condition, form('q=sample+value'))).toBe(true);
    expect(await guardBlocks(condition, form('q=sample%2Bvalue'))).toBe(false);
  });
});

describe('HTML character references', () => {
  it.each([
    ['javascript&colon;run()', 'a named reference'],
    ['javascript&#58run()', 'a decimal reference without ;'],
    ['javascript&#x3arun()', 'a hex reference without ;'],
    ['javascript&#X3A;run()', 'an upper-case hex marker'],
  ])('decodes %s (%s) before matching', (value) => {
    const condition = { parameter: 'get.u', match: { type: 'contains', value: 'javascript:' } };
    expect(blocks(condition, request({ query: { u: value } }))).toBe(true);
    expect(blocks(condition, request({ query: { u: 'javascript-run()' } }))).toBe(false);
  });

  it('keeps the text that follows a reference without ;', () => {
    expect(decodeHtmlEntities('&#58abc')).toBe(':abc');
    expect(decodeHtmlEntities('&#x3a-xyz')).toBe(':-xyz');
    expect(decodeHtmlEntities('&unknown;')).toBe('&unknown;');
  });

  it('decodes one level in the htmlentitydecode mutation', () => {
    const resolver = new RequestResolver(request());
    expect(resolver.applyMutations(['htmlentitydecode'], '&amp;lt;')).toBe('&lt;');
  });
});

describe('text mutations on structured values', () => {
  const nested = (value: unknown) => request({ method: 'POST', body: { user: value } });

  it.each([
    ['urldecode', { profile: { name: '%3Csample%3E' } }, { profile: { name: 'sample' } }],
    ['base64_decode', { profile: { name: btoa('<sample>') } }, { profile: { name: btoa('sample') } }],
    ['htmlentitydecode', { list: ['plain', '&lt;sample&gt;'] }, { list: ['plain', 'sample'] }],
  ])('%s decodes each nested string', (mutation, hit, miss) => {
    const condition = { parameter: 'post.user', mutations: [mutation], match: { type: 'contains', value: '<sample>' } };
    expect(blocks(condition, nested(hit))).toBe(true);
    expect(blocks(condition, nested(miss))).toBe(false);
  });

  it('keeps the structure for a structural match after decoding', () => {
    const condition = {
      parameter: 'post.user', mutations: ['urldecode'],
      match: { type: 'array_key_value', key: 'items.role', match: { type: 'equals', value: 'admin user' } },
    };
    expect(blocks(condition, nested({ items: [{ role: 'guest' }, { role: 'admin+user' }] }))).toBe(true);
    expect(blocks(condition, nested({ items: [{ role: 'guest' }] }))).toBe(false);
  });

  it('decodes JSON-decoded containers leaf by leaf', () => {
    const condition = { parameter: 'post.data', mutations: ['json_decode', 'urldecode'], match: { type: 'contains', value: '<sample>' } };
    const body = (inner: unknown) => request({ method: 'POST', body: { data: JSON.stringify(inner) } });
    expect(blocks(condition, body({ deep: [{ value: '%3Csample%3E' }] }))).toBe(true);
    expect(blocks(condition, body({ deep: [{ value: 'sample' }] }))).toBe(false);
  });

  it('leaves non-string leaves and the original value unchanged', () => {
    const value = { count: 3, flag: true, none: null, text: '%41' };
    const resolver = new RequestResolver(request());
    expect(resolver.applyMutations(['urldecode'], value)).toEqual({ count: 3, flag: true, none: null, text: 'A' });
    expect(value.text).toBe('%41');
  });

  it('terminates on a cyclic value', () => {
    const value: Record<string, unknown> = { text: '%3Csample%3E' };
    value.self = value;
    const resolver = new RequestResolver(request());
    const decoded = resolver.applyMutations(['urldecode'], value) as Record<string, unknown>;
    expect(decoded.text).toBe('<sample>');
    expect(decoded.self).toBe(decoded);
  });

  it('decodes within its bounds on a deeply nested value without throwing', () => {
    let value: Record<string, unknown> = { text: '%41' };
    for (let i = 0; i < 50_000; i++) value = { next: value, text: '%41' };
    const resolver = new RequestResolver(request());
    const decoded = resolver.applyMutations(['urldecode'], value) as Record<string, unknown>;
    expect(decoded.text).toBe('A');
    expect((decoded.next as Record<string, unknown>).text).toBe('A');
  });

  it('keeps an own __proto__ key as data', () => {
    const value = JSON.parse('{"__proto__":{"text":"%3Csample%3E"}}');
    const resolver = new RequestResolver(request());
    const decoded = resolver.applyMutations(['urldecode'], value);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value).toEqual({ text: '<sample>' });
  });
});

describe('normalization depth', () => {
  // `levels` nested objects, the innermost holding `text`: the top object is level 0, the innermost is
  // level `levels - 1`.
  const nest = (levels: number, text: string) => {
    let value: Record<string, unknown> = { text };
    for (let i = 1; i < levels; i++) value = { next: value };
    return value;
  };
  const innermost = (value: any): any => (value.next ? innermost(value.next) : value);

  it('normalizes a value at the deepest level inside the bound, without reporting a limit', () => {
    let limits = 0;
    const out = normalizeObject(nest(1000, '%3Csample%3E'), { onLimit: () => { limits++; } });
    expect(innermost(out).text).toBe('<sample>');
    expect(limits).toBe(0);
  });

  it('keeps a value one level past the bound as it is, and reports the limit', () => {
    let limits = 0;
    const out = normalizeObject(nest(1001, '%3Csample%3E'), { onLimit: () => { limits++; } });
    expect(innermost(out).text).toBe('%3Csample%3E');
    expect(limits).toBe(1);
  });

  it('reports a limit reached at the top of the walk', () => {
    let limits = 0;
    const value = { text: '%41' };
    expect(normalizeObject(value, { onLimit: () => { limits++; } }, 1000)).toBe(value);
    expect(limits).toBe(1);
  });

  it('normalizes nested values well past a few hundred levels', () => {
    const condition = { parameter: 'post.data', match: { type: 'contains', value: '<sample>' } };
    const deep = (text: string) => request({ method: 'POST', body: { data: nest(500, text) } });
    expect(blocks(condition, deep('%3Csample%3E'))).toBe(true);
    expect(blocks(condition, deep('%3Cother%3E'))).toBe(false);
  });

  it('normalizes a cyclic value once per node', () => {
    const value: Record<string, unknown> = { text: '%41' };
    value.self = value;
    const out = normalizeObject(value) as Record<string, unknown>;
    expect(out.text).toBe('A');
    expect(out.self).toBe(out);
  });

  it('keeps array holes and non-string leaves', () => {
    const value = [1, , '%41', null, true];
    const out = normalizeObject(value) as unknown[];
    expect(out).toHaveLength(5);
    expect(1 in out).toBe(false);
    expect(out).toEqual([1, undefined, 'A', null, true]);
    expect(normalizeObject(['%41', , ]) as unknown[]).toHaveLength(2);
  });

  async function screened(body: unknown, onSkip: (event: any) => void, parameter = 'post.data') {
    const protection: any = await createProtection({
      mode: 'dry-run',
      rules: { firewall: [{ id: 1, title: 'sample', rule_v2: [{ parameter, match: { type: 'isset' } }] }], whitelists: [], whitelist_keys: {} },
      onSkip,
    });
    const guard = protection.fetchGuard();
    const send = () => guard(new Request('https://app.example.test/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    return { protection, send };
  }

  it('reports a request past the bound as a container-cap skip, once per request', async () => {
    const skips: any[] = [];
    const { protection, send } = await screened({ data: nest(1001, 'sample'), more: nest(1001, 'sample') }, (event) => skips.push(event));
    await send();
    expect(protection.coverage().skipped['request:container-cap']).toBe(1);
    await send();
    expect(protection.coverage().skipped['request:container-cap']).toBe(2);
    expect(skips.map((event) => [event.phase, event.reason])).toEqual([['request', 'container-cap'], ['request', 'container-cap']]);
  });

  it('reports the skip when no rule matches the request', async () => {
    const skips: any[] = [];
    const { protection, send } = await screened({ data: nest(1001, 'sample') }, (event) => skips.push(event), 'post.absent');
    await send();
    expect(protection.coverage().skipped['request:container-cap']).toBe(1);
    expect(skips).toHaveLength(1);
  });

  it('reports nothing for a request inside the bound', async () => {
    const skips: any[] = [];
    const { protection, send } = await screened({ data: nest(999, 'sample') }, (event) => skips.push(event));
    await send();
    expect(protection.coverage().skipped['request:container-cap']).toBeUndefined();
    expect(skips).toEqual([]);
  });
});
