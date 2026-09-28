import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createProtection } from '../../src/protect/runtime.js';

async function screen(text: string, value: string, mode = 'block', type = 'application/json') {
  const protection = await createProtection({
    mode,
    rules: { firewall: [], whitelists: [], whitelist_keys: {} },
    responseRules: [{
      id: 'text-format', phase: 'response', action: 'encode',
      rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value } }],
    }],
  });
  return protection.screenResponse(new Response(text, { headers: { 'content-type': type } }));
}

describe('span encoding and JSON representation', () => {
  const text = JSON.stringify({ message: '<label title="sample">text</label>' });
  const match = '<label title=\\"sample\\">';

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
