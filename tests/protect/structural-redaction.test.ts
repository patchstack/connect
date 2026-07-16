import { describe, expect, it } from 'vitest';
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
