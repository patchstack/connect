import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { RuleEngine } from '../../src/protect/engine/index.js';
import { fromNodeRequest } from '../../src/protect/engine/node.js';
import { fromFetchRequest } from '../../src/protect/engine/fetch.js';

const engineFor = (rule: object) => new RuleEngine({ firewall: [rule], whitelists: [], whitelist_keys: {} } as any);
const shape = (method: string, url: string, headers: Record<string, string> = {}) => fromNodeRequest({ method, url, headers } as any, '');

describe('A2 — when: method/path scope', () => {
  it('applies only on the scoped method + path', () => {
    const e = engineFor({ id: 'scoped', when: { method: ['POST'], path: '/api/orders' }, rule_v2: [{ parameter: 'get.q', match: { type: 'isset' } }] });
    expect(e.evaluate(shape('POST', '/api/orders?q=1')).blocked).toBe(true);
    expect(e.evaluate(shape('GET', '/api/orders?q=1')).blocked).toBe(false); // wrong method
    expect(e.evaluate(shape('POST', '/api/other?q=1')).blocked).toBe(false); // wrong path
  });

  it('supports a path glob', () => {
    const g = engineFor({ id: 'g', when: { path: '/api/*' }, rule_v2: [{ parameter: 'get.q', match: { type: 'isset' } }] });
    expect(g.evaluate(shape('GET', '/api/orders/42?q=1')).blocked).toBe(true);
    expect(g.evaluate(shape('GET', '/admin?q=1')).blocked).toBe(false);
  });
});

describe('A3 — cross_origin (CSRF primitive)', () => {
  const e = engineFor({ id: 'csrf', when: { method: ['POST', 'PUT', 'DELETE'] }, category: 'csrf', rule_v2: [{ match: { type: 'cross_origin' } }] });

  it('blocks a cross-site state-changing request, allows same-origin / origin-less / safe methods', () => {
    expect(e.evaluate(shape('POST', '/x', { host: 'app.test', origin: 'https://evil.example' })).blocked).toBe(true);
    expect(e.evaluate(shape('POST', '/x', { host: 'app.test', origin: 'https://app.test' })).blocked).toBe(false); // same origin
    expect(e.evaluate(shape('POST', '/x', { host: 'app.test' })).blocked).toBe(false); // no Origin/Referer → lenient
    expect(e.evaluate(shape('GET', '/x', { host: 'app.test', origin: 'https://evil.example' })).blocked).toBe(false); // safe method
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(e.evaluate(shape('POST', '/x', { host: 'app.test', referer: 'https://evil.example/page' })).blocked).toBe(true);
  });
});

describe('A1 — encode response action', () => {
  const jsonResponse = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
  async function screen(rule: object, response: Response) {
    const p: any = await createProtection({ rules: { firewall: [], whitelists: [], whitelist_keys: {} }, responseRules: [rule], mode: 'block' });
    return p.screenResponse(response);
  }

  it('HTML-escapes a JSON field across nested arrays (structural)', async () => {
    const rule = { id: 'enc', phase: 'response', category: 'xss', action: 'encode', rule_v2: [{ parameter: 'response.body', mutations: ['json_decode'], match: { type: 'array_key_value', key: 'comments.body', match: { type: 'isset' } } }] };
    const got = JSON.parse(await (await screen(rule, jsonResponse({ comments: [{ body: '<script>x</script>' }, { body: 'ok' }] }))).text());
    expect(got.comments[0].body).toBe('&lt;script&gt;x&lt;/script&gt;'); // markup neutralized, still served
    expect(got.comments[1].body).toBe('ok'); // no markup → unchanged
  });

  it('escapes a matched span in a text body', async () => {
    const rule = { id: 'enc2', phase: 'response', category: 'xss', action: 'encode', rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/<script>/i' } }] };
    const out = await screen(rule, new Response('hi <script> there', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await out.text()).toBe('hi &lt;script&gt; there');
  });
});

describe('B3 — streaming request-body cap (no Content-Length)', () => {
  const streamOf = (s: string) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } });

  it('bounds the scanned prefix and leaves the original body intact', async () => {
    const big = 'A'.repeat(5000);
    const req = new Request('https://app/x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: streamOf(big), duplex: 'half' } as any);
    const shaped: any = await fromFetchRequest(req, { maxBodyBytes: 64 });
    expect(shaped._rawBody).toBe('A'.repeat(64)); // bounded to the scan cap, not the full 5000
    expect((await req.text()).length).toBe(5000); // original body still fully readable downstream
  });
});
