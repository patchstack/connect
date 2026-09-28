import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createProtection } from '../../src/protect/runtime.js';

async function screen(text: string, value: string, mode = 'block', type = 'application/json', action = 'encode') {
  const protection = await createProtection({
    mode,
    rules: { firewall: [], whitelists: [], whitelist_keys: {} },
    responseRules: [{
      id: 'text-format', phase: 'response', action,
      rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value } }],
    }],
  });
  return protection.screenResponse(new Response(text, { headers: { 'content-type': type } }));
}

describe('span encoding and JSON representation', () => {
  const text = JSON.stringify({ message: '<label title="sample">text</label>' });
  const match = '<label title=\\"sample\\">';

  it.each(['encode', 'redact'])('withholds a %s span crossing object fields', async (action) => {
    const response = await screen('{"label":"first","state":"second"}', 'first","state":"second', 'block', 'application/json', action);
    expect(response.status).toBe(500);
    expect(await response.json()).toHaveProperty('error');
  });

  it('withholds a span that changes an object key', async () => {
    const response = await screen('{"<label>":"sample"}', '<label>');
    expect(response.status).toBe(500);
  });

  it.each([
    ['{"list":["first","second"]}', 'first","second'],
    ['{"value":true}', 'true'],
    ['{"value":123}', '123'],
    ['{"value":null}', 'null'],
  ])('preserves containers and non-string values in %s', async (document, value) => {
    const response = await screen(document, value, 'block', 'application/json', 'redact');
    expect(response.status).toBe(500);
  });

  it('allows nested string changes without changing adjacent values', async () => {
    const response = await screen('{"list":[{"label":"<label>","count":1}],"enabled":true,"empty":null}', '<label>');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ list: [{ label: '&lt;label&gt;', count: 1 }], enabled: true, empty: null });
  });

  it('checks span changes separately from explicit path transformations', async () => {
    const protection = await createProtection({
      mode: 'block',
      rules: { firewall: [], whitelists: [], whitelist_keys: {} },
      responseRules: [
        {
          id: 'field-format', phase: 'response', action: 'redact',
          rule_v2: [{
            parameter: 'response.body', mutations: ['json_decode'],
            match: { type: 'array_key_value', key: 'count', match: { type: 'isset' } },
          }],
        },
        {
          id: 'text-format', phase: 'response', action: 'encode',
          rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: '<label>' } }],
        },
      ],
    });
    const response = await protection.screenResponse(new Response('{"count":12,"label":"<label>"}'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: '[REDACTED]', label: '&lt;label&gt;' });
  });

  it('does not tokenize an incomplete intermediate document', async () => {
    const document = JSON.stringify({ value: 12, label: '"'.repeat(128) + 'sample' });
    const suffix = 'sample"}';
    const incomplete = document.slice(0, -suffix.length) + '[REDACTED]';
    const matchAll = String.prototype.matchAll;
    let scannedIncomplete = false;
    const scanSpy = vi.spyOn(String.prototype, 'matchAll').mockImplementation(function (regexp) {
      if (String(this) === incomplete) scannedIncomplete = true;
      return matchAll.call(this, regexp);
    });
    try {
      const protection = await createProtection({
        mode: 'block',
        rules: { firewall: [], whitelists: [], whitelist_keys: {} },
        responseRules: [
          {
            id: 'text-format', phase: 'response', action: 'redact',
            rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: suffix } }],
          },
          {
            id: 'field-format', phase: 'response', action: 'redact',
            rule_v2: [{
              parameter: 'response.body', mutations: ['json_decode'],
              match: { type: 'array_key_value', key: 'value', match: { type: 'isset' } },
            }],
          },
        ],
      });
      const response = await protection.screenResponse(new Response(document));
      expect(response.status).toBe(500);
      expect(scannedIncomplete).toBe(false);
    } finally {
      scanSpy.mockRestore();
    }
  });

  it.each(['application/json', 'text/plain'])('withholds a rewrite that cannot remain valid JSON (%s)', async (type) => {
    const response = await screen(text, match, 'block', type);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Response withheld by Patchstack (sensitive data detected)' });
  });

  it('keeps a representable span encoded inside JSON', async () => {
    const response = await screen(JSON.stringify({ message: '<label>text</label>' }), '<label>');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: '&lt;label&gt;text</label>' });
  });

  it('leaves dry-run output byte-for-byte unchanged', async () => {
    const response = await screen(text, match, 'dry-run');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
  });

  it('still encodes ordinary HTML text', async () => {
    const response = await screen('<label title="sample">text</label>', '<label title="sample">', 'block', 'text/html');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('&lt;label title=&quot;sample&quot;&gt;text</label>');
  });

  it('sends a complete withheld response through the Node adapter', async () => {
    const protection = await createProtection({
      mode: 'block',
      rules: { firewall: [], whitelists: [], whitelist_keys: {} },
      responseRules: [{
        id: 'text-format', phase: 'response', action: 'encode',
        rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: match } }],
      }],
    });
    const middleware = protection.node({ screenResponses: true });
    const server = createServer((req, res) => middleware(req, res, () => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const response = await fetch('http://127.0.0.1:' + address.port);
      const received = await response.text();
      expect(response.status).toBe(500);
      expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(received));
      expect(JSON.parse(received)).toEqual({ error: 'Response withheld by Patchstack (sensitive data detected)' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      protection.stop();
    }
  });
});
