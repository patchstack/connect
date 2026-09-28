import { describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// Structural response masking: an `array_key_value` redact rule masks the VALUE at a JSON path,
// fanning out over arrays at every segment (e.g. orders.customers.email masks that field in every
// customer of every order), rather than a text span. Path-scoped, so it never touches a same-named
// field elsewhere in the document.

const jsonResponse = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

function maskRule(key: string, inner?: object) {
  return {
    id: 'mask-path',
    phase: 'response',
    category: 'pii',
    action: 'redact',
    rule_v2: [{ parameter: 'response.body', mutations: ['json_decode'], match: { type: 'array_key_value', key, match: inner ?? { type: 'isset' } } }],
  };
}

async function screen(rule: object, response: Response, opts: Record<string, unknown> = {}) {
  const p: any = await createProtection({ rules: { firewall: [], whitelists: [], whitelist_keys: {} }, responseRules: [rule], mode: 'block', ...opts });
  return p.screenResponse(response);
}
const body = async (r: Response) => JSON.parse(await r.text());

describe('structural response redaction (array_key_value → mask)', () => {
  it('validates the complete document before scanning number tokens', async () => {
    const document = '{"value":4000000000000000}';
    const calls: string[] = [];
    const parse = JSON.parse;
    const matchAll = String.prototype.matchAll;
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((...args) => {
      if (args[0] === document) calls.push('validate');
      return parse(...args);
    });
    const scanSpy = vi.spyOn(String.prototype, 'matchAll').mockImplementation(function (regexp) {
      if (String(this) === document) calls.push('scan');
      return matchAll.call(this, regexp);
    });
    try {
      const out = await screen(maskRule('value'), new Response(document), {
        onDetect: () => { calls.length = 0; },
      });
      expect(calls.indexOf('validate')).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf('scan')).toBeGreaterThan(calls.indexOf('validate'));
      expect(await body(out)).toEqual({ value: '[REDACTED]' });
    } finally {
      scanSpy.mockRestore();
      parseSpy.mockRestore();
    }
  });

  it.each(['4111111111111111', '41111111111111110', '-4111111111111111'])(
    'matches a numeric leaf %s while preserving unrelated integers', async (value) => {
      const doc = `{"items":[{"value":${value}},{"value":12}],"id":12345678901234567890}`;
      const out = await screen(maskRule('items.value', { type: 'regex', value: '/^-?4\\d{15,16}$/' }),
        new Response(doc, { headers: { 'content-type': 'application/json' } }));
      const text = await out.text();
      expect(out.status).toBe(200);
      expect(JSON.parse(text).items).toEqual([{ value: '[REDACTED]' }, { value: 12 }]);
      expect(text).toContain('"id":12345678901234567890');
    },
  );

  it('keeps numeric predicates type-consistent with detection', async () => {
    const doc = '{"value":4000000000000000}';
    const out = await screen(maskRule('value', { type: 'equals_strict', value: '4000000000000000' }),
      new Response(doc, { headers: { 'content-type': 'application/json' } }));
    expect(await body(out)).toEqual({ value: '[REDACTED]' });
  });

  it('preserves literal marker-like strings and decimal values during masking', async () => {
    const doc = '{"email":"sample@example.test","literal":"__PSBIGINT_9c2f__12345678901234567890__DNEGIB__","escaped":"\\u005f_PSNUMBER_0__","decimal":0.1234567890123456789,"id":12345678901234567890}';
    const out = await screen(maskRule('email'), new Response(doc));
    const text = await out.text();
    expect(JSON.parse(text)).toMatchObject({
      email: '[REDACTED]',
      literal: '__PSBIGINT_9c2f__12345678901234567890__DNEGIB__',
      escaped: '__PSNUMBER_0__',
      decimal: JSON.parse(doc).decimal,
    });
    expect(text).toContain('"id":12345678901234567890');
  });

  it('does not interpret a custom mask as a preserved number', async () => {
    const doc = '{"value":4000000000000000,"id":12345678901234567890}';
    const out = await screen(maskRule('value'), new Response(doc), { maskWith: '__PSNUMBER_0__' });
    const text = await out.text();
    expect(JSON.parse(text).value).toBe('__PSNUMBER_0__');
    expect(text).toContain('"id":12345678901234567890');
  });

  it('masks a field across every element of nested arrays (arbitrary length)', async () => {
    const doc = {
      orders: [
        { id: 1, customers: [{ name: 'Ada', email: 'ada@x.com' }, { name: 'Bo', email: 'bo@x.com' }] },
        { id: 2, customers: [{ name: 'Cy', email: 'cy@x.com' }] },
      ],
    };
    const got = await body(await screen(maskRule('orders.customers.email'), jsonResponse(doc)));
    expect(got.orders[0].customers[0].email).toBe('[REDACTED]');
    expect(got.orders[0].customers[1].email).toBe('[REDACTED]');
    expect(got.orders[1].customers[0].email).toBe('[REDACTED]');
    // everything else is untouched
    expect(got.orders[0].customers[0].name).toBe('Ada');
    expect(got.orders[0].id).toBe(1);
  });

  it('is path-scoped — a same-named field on a different path is NOT masked', async () => {
    const doc = { orders: [{ customers: [{ email: 'buyer@x.com' }] }], supportContact: { email: 'help@x.com' } };
    const got = await body(await screen(maskRule('orders.customers.email'), jsonResponse(doc)));
    expect(got.orders[0].customers[0].email).toBe('[REDACTED]');
    expect(got.supportContact.email).toBe('help@x.com'); // untouched — regex-over-text couldn't do this
  });

  it('masks conditionally when the nested match is a condition (only matching leaves)', async () => {
    const doc = { orders: [{ customers: [{ email: 'mal@evil.com' }, { email: 'ok@good.com' }] }] };
    const got = await body(await screen(maskRule('orders.customers.email', { type: 'regex', value: '/@evil\\.com$/' }), jsonResponse(doc)));
    expect(got.orders[0].customers[0].email).toBe('[REDACTED]');
    expect(got.orders[0].customers[1].email).toBe('ok@good.com');
  });

  it('honors a custom maskWith', async () => {
    const doc = { orders: [{ customers: [{ email: 'x@x.com' }] }] };
    const got = await body(await screen(maskRule('orders.customers.email'), jsonResponse(doc), { maskWith: '***' }));
    expect(got.orders[0].customers[0].email).toBe('***');
  });

  it('fails open on a non-JSON body (returned unchanged)', async () => {
    const resp = new Response('plain text, not json', { status: 200, headers: { 'content-type': 'text/plain' } });
    const out = await screen(maskRule('orders.customers.email'), resp);
    expect(await out.text()).toBe('plain text, not json');
  });

  it('leaves the body unchanged when the path is absent', async () => {
    const doc = { users: [{ email: 'u@x.com' }] }; // no orders.customers.email
    const got = await body(await screen(maskRule('orders.customers.email'), jsonResponse(doc)));
    expect(got.users[0].email).toBe('u@x.com');
  });
});

describe('response size cap + per-rule override', () => {
  // A body padded past the default 512 KiB screening cap.
  const doc = () => ({ orders: [{ customers: [{ email: 'x@x.com', pad: 'a'.repeat(700 * 1024) }] }] });
  const emailOf = async (r: Response) => (await body(r)).orders[0].customers[0].email;

  it('does NOT mask a body over the default cap (fail-open → unscreened)', async () => {
    const out = await screen(maskRule('orders.customers.email'), jsonResponse(doc()));
    expect(await emailOf(out)).toBe('x@x.com'); // over cap → skipped, passes through unmasked
  });

  it('masks an over-cap body when the rule sets bypass_limit: true', async () => {
    const rule = { ...maskRule('orders.customers.email'), bypass_limit: true };
    expect(await emailOf(await screen(rule, jsonResponse(doc())))).toBe('[REDACTED]');
  });

  it('masks when max_bytes raises the ceiling above the body size', async () => {
    const rule = { ...maskRule('orders.customers.email'), max_bytes: 2 * 1024 * 1024 };
    expect(await emailOf(await screen(rule, jsonResponse(doc())))).toBe('[REDACTED]');
  });

  it('still skips when max_bytes is below the body size', async () => {
    const rule = { ...maskRule('orders.customers.email'), max_bytes: 600 * 1024 }; // < ~700 KiB body
    expect(await emailOf(await screen(rule, jsonResponse(doc())))).toBe('x@x.com');
  });
});

describe('array_key_value matching now fans out over mid-path arrays', () => {
  it('blocks a request when a nested-array leaf matches (filter side)', async () => {
    const rule = {
      id: 'block-bad-sku',
      category: 'test',
      rule_v2: [{ parameter: 'raw', mutations: ['json_decode'], match: { type: 'array_key_value', key: 'orders.items.sku', match: { type: 'contains', value: 'BANNED' } } }],
    };
    const p: any = await createProtection({ rules: { firewall: [rule], whitelists: [], whitelist_keys: {} }, mode: 'block' });
    const guard = p.fetchGuard();
    const req = (obj: unknown) => new Request('https://app.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
    expect(await guard(req({ orders: [{ items: [{ sku: 'OK-1' }, { sku: 'BANNED-9' }] }] }))).not.toBeNull(); // mid-path arrays
    expect(await guard(req({ orders: [{ items: [{ sku: 'OK-1' }] }] }))).toBeNull();
  });
});
