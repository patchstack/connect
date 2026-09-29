import { describe, expect, it } from 'vitest';
import { RuleEngine } from '../../src/protect/engine/engine.js';
import { createFetchMiddleware, fromFetchRequest } from '../../src/protect/engine/fetch.js';
import { fromNodeRequest } from '../../src/protect/engine/node.js';
import { createProtection } from '../../src/protect/runtime.js';

// A rule names a request field once. These cover the shapes the same field can arrive in — the parser
// that produced it, its spelling, its size — and that each shape reaches the rule.

const MARKER = 'sample-marker';

const engineFor = (parameter: string, match: object = { type: 'contains', value: MARKER }) =>
  new RuleEngine({
    firewall: [{ id: 1, title: 'field shape', rule_v2: [{ parameter, match }] }],
    whitelists: [],
    whitelist_keys: {},
  } as any);

const blocks = async (engine: RuleEngine, request: Request | Record<string, unknown>) =>
  engine.evaluate(request instanceof Request ? await fromFetchRequest(request) : request).blocked;

const shaped = (overrides: Record<string, unknown>) => ({
  method: 'GET',
  url: '/',
  originalUrl: '/',
  headers: {},
  query: {},
  body: {},
  ...overrides,
});

describe('cookie values', () => {
  const rule = engineFor('cookie.pref');

  it('reads a percent-encoded value from the Cookie header as the application does', async () => {
    const request = new Request('https://app.test/', { headers: { cookie: 'pref=sample%2Dmarker' } });
    expect(await blocks(rule, request)).toBe(true);
  });

  it('normalises cookies a framework already parsed the same way', async () => {
    expect(await blocks(rule, shaped({ cookies: { pref: 'sample%252Dmarker' } }))).toBe(true);
  });

  it('strips the double quotes around a quoted value', async () => {
    const exact = engineFor('cookie.pref', { type: 'equals', value: MARKER });
    const request = new Request('https://app.test/', { headers: { cookie: `pref="${MARKER}"` } });
    expect(await blocks(exact, request)).toBe(true);
  });

  it.each([
    ['first', `pref=${MARKER}; pref=plain`],
    ['last', `pref=plain; pref=${MARKER}`],
  ])('inspects every value of a repeated name (%s)', async (_label, cookie) => {
    expect(await blocks(rule, new Request('https://app.test/', { headers: { cookie } }))).toBe(true);
  });

  it('splits pairs before decoding their values', async () => {
    // An encoded separator is part of the value; it does not start another cookie.
    const present = engineFor('cookie.other', { type: 'isset' });
    const request = new Request('https://app.test/', { headers: { cookie: 'pref=one%3B%20other%3Dtwo' } });
    expect(await blocks(present, request)).toBe(false);
    expect(await blocks(engineFor('cookie.pref', { type: 'contains', value: 'other=two' }), request)).toBe(true);
  });

  it('reads the Cookie header the same way on the Node adapter', () => {
    const request = fromNodeRequest({
      method: 'GET',
      url: '/',
      headers: { host: 'app.test', cookie: `pref=plain; pref="${MARKER}"` },
      socket: { remoteAddress: '198.51.100.7' },
    });
    expect(request.cookies).toEqual({ pref: ['plain', MARKER] });
  });

  it('leaves an ordinary cookie alone', async () => {
    const request = new Request('https://app.test/', { headers: { cookie: 'pref=plain' } });
    expect(await blocks(rule, request)).toBe(false);
  });
});

describe('bracketed field names', () => {
  it.each([
    ['a nested query field', 'get.user.name', 'https://app.test/?user[name]=sample-marker'],
    ['an array query field', 'get.id', 'https://app.test/?id[]=sample-marker'],
    ['a nested array query field', 'get.user.tags', 'https://app.test/?user[tags][]=sample-marker'],
  ])('resolves %s sent in bracket form', async (_label, parameter, url) => {
    expect(await blocks(engineFor(parameter), new Request(url))).toBe(true);
  });

  it('resolves a form field sent in bracket form', async () => {
    const request = new Request('https://app.test/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user%5Bname%5D=sample-marker',
    });
    expect(await blocks(engineFor('post.user.name'), request)).toBe(true);
  });

  it('resolves the request source in bracket form, from the query or the body', async () => {
    const rule = engineFor('request.user.name');
    expect(await blocks(rule, new Request('https://app.test/?user[name]=sample-marker'))).toBe(true);
    const form = new Request('https://app.test/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user%5Bname%5D=sample-marker',
    });
    expect(await blocks(rule, form)).toBe(true);
  });

  it('resolves a bracket-form rule against a parser that expanded the brackets', async () => {
    expect(await blocks(engineFor('get.user[name]'), shaped({ query: { user: { name: MARKER } } }))).toBe(true);
    expect(await blocks(engineFor('get.id[]'), shaped({ query: { id: [MARKER] } }))).toBe(true);
  });

  it('does not treat a different field as the named one', async () => {
    const rule = engineFor('get.user.name');
    expect(await blocks(rule, new Request('https://app.test/?user[nickname]=sample-marker'))).toBe(false);
    expect(await blocks(rule, new Request('https://app.test/?username=sample-marker'))).toBe(false);
  });
});

describe('a structured value larger than the leaf walk', () => {
  // More containers than the walk visits, with the marker inside one past the bound.
  const oversized = () => {
    const items: unknown[] = Array.from({ length: 20_500 }, () => ({}));
    items.push({ note: MARKER });
    return JSON.stringify({ items });
  };
  const post = (body: string) =>
    new Request('https://app.test/', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  it('still matches a value past the bound', async () => {
    expect(await blocks(engineFor('post.items'), post(oversized()))).toBe(true);
  });

  it('reports that the bound was reached', async () => {
    const skips: any[] = [];
    const protection: any = await createProtection({
      mode: 'block',
      rules: {
        firewall: [{ id: 1, title: 'field shape', rule_v2: [{ parameter: 'post.items', match: { type: 'contains', value: 'absent-marker' } }] }],
        whitelists: [],
        whitelist_keys: {},
      },
      onSkip: (skip: any) => skips.push(skip),
    });

    await protection.fetchGuard()(post(oversized()));

    expect(protection.coverage().skipped['request:container-cap']).toBe(1);
    expect(skips).toEqual([expect.objectContaining({ phase: 'request', reason: 'container-cap' })]);
  });

  it('reports the bound on a request it blocks', async () => {
    const protection: any = await createProtection({
      mode: 'block',
      rules: {
        firewall: [{ id: 1, title: 'field shape', rule_v2: [{ parameter: 'post.items', match: { type: 'contains', value: MARKER } }] }],
        whitelists: [],
        whitelist_keys: {},
      },
    });

    const blocked = await protection.fetchGuard()(post(oversized()));

    expect(blocked?.status).toBe(403);
    expect(protection.coverage().skipped['request:container-cap']).toBe(1);
  });

  it('reports the bound through the standalone fetch middleware', async () => {
    const skips: any[] = [];
    const guard = createFetchMiddleware(
      {
        firewall: [{ id: 1, title: 'field shape', rule_v2: [{ parameter: 'post.items', match: { type: 'contains', value: 'absent-marker' } }] }],
        whitelists: [],
        whitelist_keys: {},
      } as any,
      { onSkip: (skip: any) => skips.push(skip) },
    );

    expect(await guard(post(oversized()))).toBeNull();
    expect(skips).toEqual([{ phase: 'request', reason: 'container-cap' }]);
  });

  it.each(['node', 'express'])('reports the bound through the %s guard', async (guard) => {
    const protection: any = await createProtection({
      mode: 'block',
      rules: {
        firewall: [{ id: 1, title: 'field shape', rule_v2: [{ parameter: 'post.items', match: { type: 'contains', value: 'absent-marker' } }] }],
        whitelists: [],
        whitelist_keys: {},
      },
    });
    // A body another parser already produced, so neither guard reads the stream.
    const req = {
      method: 'POST',
      url: '/',
      originalUrl: '/',
      headers: { 'content-type': 'application/json' },
      query: {},
      body: JSON.parse(oversized()),
      socket: { remoteAddress: '198.51.100.7' },
      readableEnded: true,
    };
    const res: any = { statusCode: 200, setHeader() {}, getHeader() {}, end() {}, status() { return this; }, json() { return this; } };
    let passed = false;
    protection[guard]()(req, res, () => { passed = true; });

    expect(passed).toBe(true);
    expect(protection.coverage().skipped['request:container-cap']).toBe(1);
    protection.stop();
  });

  it('reports the bound once per screened response', async () => {
    const protection: any = await createProtection({
      mode: 'block',
      rules: { firewall: [], whitelists: [], whitelist_keys: {} },
      responseRules: ['first', 'second'].map((id) => ({
        id,
        phase: 'response',
        action: 'block',
        rule_v2: [{ parameter: 'response.body', mutations: ['json_decode'], match: { type: 'contains', value: 'absent-marker' } }],
      })),
    });
    const response = await protection.screenResponse(
      new Response(oversized(), { headers: { 'content-type': 'application/json' } }),
    );

    expect(response.status).toBe(200);
    expect(protection.coverage().skipped['response:container-cap']).toBe(1);
  });

  describe('when a decoding mutation reaches it', () => {
    // A whole-value matcher reads the decoded structure directly, without the leaf walk, so the decoding
    // walk's own bound is the only one this value meets.
    const decodedRule = (list: unknown[]) => ({
      rules: {
        firewall: [{
          id: 1,
          title: 'decoded field',
          rule_v2: [{
            parameter: 'post.data',
            mutations: ['base64_decode'],
            match: { type: 'array_key_value', key: 'list.v', match: { type: 'contains', value: MARKER } },
          }],
        }],
        whitelists: [],
        whitelist_keys: {},
      },
      body: JSON.stringify({ data: { list } }),
    });
    const listOf = (padding: number) => {
      const list: unknown[] = Array.from({ length: padding }, () => ({}));
      list.push({ v: Buffer.from(MARKER).toString('base64') });
      return list;
    };

    it('reports that the decoding bound was reached', async () => {
      const { rules, body } = decodedRule(listOf(20_500));
      const protection: any = await createProtection({ mode: 'block', rules });
      await protection.fetchGuard()(post(body));
      expect(protection.coverage().skipped['request:container-cap']).toBe(1);
    });

    it('decodes and matches a value within it, reporting nothing', async () => {
      const { rules, body } = decodedRule(listOf(100));
      const protection: any = await createProtection({ mode: 'block', rules });
      expect((await protection.fetchGuard()(post(body)))?.status).toBe(403);
      expect(protection.coverage().skipped['request:container-cap']).toBeUndefined();
    });
  });

  it('reports nothing for a value within the bound', async () => {
    const skips: any[] = [];
    const protection: any = await createProtection({
      mode: 'block',
      rules: {
        firewall: [{ id: 1, title: 'field shape', rule_v2: [{ parameter: 'post.items', match: { type: 'contains', value: 'absent-marker' } }] }],
        whitelists: [],
        whitelist_keys: {},
      },
      onSkip: (skip: any) => skips.push(skip),
    });

    await protection.fetchGuard()(post(JSON.stringify({ items: [{ note: 'plain' }] })));

    expect(protection.coverage().skipped['request:container-cap']).toBeUndefined();
    expect(skips).toEqual([]);
  });
});
