import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// A text-span rewrite of a JSON response may change string values only. Anything that would leave the
// document invalid, or change its keys, containers or other values, withholds the response instead.

const rules = { firewall: [], whitelists: [], whitelist_keys: {} };

const spanRule = (id: string, match: object) => ({
  id, phase: 'response', action: 'redact',
  rule_v2: [{ parameter: 'response.body', match }],
});

async function rewrite(doc: string, responseRules: object[], options: Record<string, unknown> = {}) {
  const protection: any = await createProtection({ mode: 'block', rules, responseRules, ...options });
  const response = await protection.screenResponse(new Response(doc, { headers: { 'content-type': 'application/json' } }));
  return { status: response.status, text: await response.text() };
}

describe('a span rewrite inside a JSON document', () => {
  it('withholds a mask that puts a raw control character into a string', async () => {
    const out = await rewrite('{"note":"SAMPLE"}', [spanRule('value', { type: 'contains', value: 'SAMPLE' })], { maskWith: 'line\nbreak' });
    expect(out.status).toBe(500);
  });

  it('withholds a rewrite that leaves whitespace JSON does not allow between tokens', async () => {
    const out = await rewrite('{"a":"x" ,"b":"y"}', [spanRule('gap', { type: 'regex', value: '/ ,/' })], { maskWith: ' ,' });
    expect(out.status).toBe(500);
  });

  it('allows a rewrite that only changes whitespace JSON allows', async () => {
    const out = await rewrite('{"a":"x" ,"b":"y"}', [spanRule('gap', { type: 'regex', value: '/ ,/' })], { maskWith: '\t,' });
    expect(out.status).toBe(200);
    expect(out.text).toBe('{"a":"x"\t,"b":"y"}');
  });

  // A non-ASCII escape, which screening leaves escaped, so the rewrite reaches the escape itself.
  it('withholds a rewrite that breaks a unicode escape', async () => {
    const out = await rewrite('{"a":"\\u00e9BC"}', [spanRule('escape', { type: 'contains', value: '00e9' })], { maskWith: 'zzzz' });
    expect(out.status).toBe(500);
  });

  it('allows a rewrite that keeps a unicode escape well formed', async () => {
    const out = await rewrite('{"a":"\\u00e9BC"}', [spanRule('escape', { type: 'contains', value: '00e9' })], { maskWith: '00e8' });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.text)).toEqual({ a: '\u00e8BC' });
  });

  it('allows a key spelled with different escapes when it still names the same member', async () => {
    const out = await rewrite('{"\\u0061":"v"}', [spanRule('key', { type: 'contains', value: '\\u0061' })], { maskWith: 'a' });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.text)).toEqual({ a: 'v' });
  });

  it.each([
    ['a number into another number', '{"value":123}', '23', '45'],
    ['a literal into another literal', '{"value":true}', 'true', 'null'],
  ])('withholds a rewrite that turns %s', async (_label, doc, value, mask) => {
    const out = await rewrite(doc, [spanRule('value', { type: 'contains', value })], { maskWith: mask });
    expect(out.status).toBe(500);
  });

  it('withholds a rewrite that adds tokens after the document', async () => {
    const out = await rewrite('{"a":"b"}', [spanRule('end', { type: 'contains', value: '}' })], { maskWith: '},{}' });
    expect(out.status).toBe(500);
  });

  it('checks each step against the document as the previous rule left it', async () => {
    const doc = '{\n  "first": "SAMPLE_ONE",\n  "count": 12,\n  "second": "SAMPLE_TWO"\n}';
    const out = await rewrite(doc, [
      spanRule('first', { type: 'contains', value: 'SAMPLE_ONE' }),
      {
        id: 'rest', phase: 'response', action: 'redact',
        rule_v2: [
          { parameter: 'response.body', mutations: ['json_decode'], match: { type: 'array_key_value', key: 'count', match: { type: 'isset' } } },
          { parameter: 'response.body', match: { type: 'contains', value: 'SAMPLE_TWO' } },
        ],
      },
    ]);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.text)).toEqual({ first: '[REDACTED]', count: '[REDACTED]', second: '[REDACTED]' });
  });
});

describe('the cost of checking a JSON document', () => {
  const responseRules = Array.from({ length: 5 }, (_, k) =>
    spanRule(`value-${k}`, { type: 'regex', value: `/SAMPLE${k}\\d+/` }));
  const document = JSON.stringify({
    items: Array.from({ length: 12_000 }, (_, i) => ({ id: i, value: `SAMPLE${i % 5}${i}` })),
  });

  it('stays a small multiple of the same rewrite on text that is not JSON', async () => {
    const protection: any = await createProtection({ mode: 'block', rules, responseRules });
    const timed = async (body: string) => {
      const startedAt = performance.now();
      const response = await protection.screenResponse(new Response(body, { headers: { 'content-type': 'application/json' } }));
      const text = await response.text();
      const elapsed = performance.now() - startedAt;
      expect(text).toContain('[REDACTED]');
      return elapsed;
    };
    // Compared with the same rules over the same bytes made invalid by one leading character, so the
    // verdict is about what the structure check adds, not how fast this machine is.
    const best = async (body: string) => {
      await timed(body);
      return Math.min(await timed(body), await timed(body), await timed(body));
    };
    const json = await best(document);
    const text = await best('x' + document);

    expect(json / Math.max(text, 0.5)).toBeLessThan(30);
  });

  it('grows linearly when a rewrite leaves a string open over a run of escaped quotes', async () => {
    // The rewrite consumes the closing delimiter, so every escaped quote after the opening one could be
    // mistaken for the start of another string by a scanner that restarts inside it.
    const protection: any = await createProtection({
      mode: 'block', rules, responseRules: [spanRule('tail', { type: 'regex', value: '/SAMPLE\\S*$/' })],
    });
    const timed = async (quotes: number) => {
      const body = '{"a":1,"x":"' + '\\"'.repeat(quotes) + 'SAMPLE"}';
      const startedAt = performance.now();
      const response = await protection.screenResponse(new Response(body, { headers: { 'content-type': 'application/json' } }));
      await response.text();
      expect(response.status).toBe(500);
      return performance.now() - startedAt;
    };
    const best = async (quotes: number) => {
      await timed(quotes);
      return Math.min(await timed(quotes), await timed(quotes), await timed(quotes));
    };
    const small = await best(10_000);
    const large = await best(80_000);

    // Eight times the input: linear work takes about eight times as long, a rescan from every quote
    // about sixty-four. Twenty-four leaves wide room for noise either way.
    expect(large / Math.max(small, 0.5)).toBeLessThan(24);
  });
});
