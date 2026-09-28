import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * The response phase screens text as the client will read it.
 *
 * A body is read as UTF-8. One in a character encoding that cannot be read that way — UTF-16 (declared,
 * or marked by a byte-order mark), or a legacy charset with bytes outside ASCII — is recorded as an
 * `unsupported-charset` skip and sent unchanged. A legacy charset over pure ASCII reads identically, so it
 * is screened; a rewrite that would put non-ASCII into it is withheld instead.
 *
 * A JSON body is screened with its `\uXXXX` and `\/` escapes read as the characters a JSON parser yields.
 * Escapes of characters that matter in markup stay escaped in a rewritten body.
 */

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
const SAMPLE = 'AKIAIOSFODNN7EXAMPLE';
const secretRule = {
  id: 'sample-key',
  phase: 'response',
  category: 'secret-exposure',
  action: 'redact',
  rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/AKIA[0-9A-Z]{16}/' } }],
};
const urlRule = {
  id: 'internal-url',
  phase: 'response',
  category: 'secret-exposure',
  action: 'redact',
  rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'http://10.0.0.1' } }],
};

async function guard(extra: Record<string, unknown> = {}) {
  const detections: any[] = [];
  const skips: any[] = [];
  const protection: any = await createProtection({
    rules: emptyBundle,
    mode: 'block',
    responseRules: [secretRule, urlRule],
    onDetect: (event: any) => detections.push(event),
    onSkip: (skip: any) => skips.push(skip),
    onError: () => {},
    ...extra,
  });

  return { protection, detections, skips };
}

const bytesOf = async (response: Response) => Buffer.from(await response.arrayBuffer());
const latin1 = (text: string) => Buffer.from(text, 'latin1');

describe('a body in another character encoding (fetch)', () => {
  it.each([
    ['declared UTF-16', 'application/json; charset=utf-16le', Buffer.from(`{"k":"${SAMPLE}"}`, 'utf16le'), 'utf-16le'],
    ['a UTF-16 byte-order mark', 'application/json', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`{"k":"${SAMPLE}"}`, 'utf16le')]), 'utf-16le'],
    ['a big-endian byte-order mark', 'text/plain', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`${SAMPLE}`, 'utf16le').swap16()]), 'utf-16be'],
    ['a legacy charset with a byte outside ASCII', 'text/html; charset=iso-8859-1', latin1(`café ${SAMPLE}`), 'iso-8859-1'],
    ['a stateful charset over ASCII bytes', 'text/plain; charset=iso-2022-jp', Buffer.from(`\u001b$B${SAMPLE}\u001b(B`, 'latin1'), 'iso-2022-jp'],
    ['declared UTF-16 whose bytes all fall in the ASCII range', 'text/plain; charset=utf-16le', Buffer.from('中字', 'utf16le'), 'utf-16le'],
    ['a legacy charset over bytes with a NUL', 'text/plain; charset=iso-8859-1', Buffer.from(SAMPLE, 'utf16le'), 'iso-8859-1'],
  ])('is sent unchanged under %s, and the skip is recorded', async (_label, type, body, charset) => {
    const { protection, detections, skips } = await guard();
    const out = await protection.screenResponse(new Response(body, { headers: { 'content-type': type } }));

    expect((await bytesOf(out)).equals(body)).toBe(true);
    expect(detections).toHaveLength(0);
    expect(skips).toContainEqual(expect.objectContaining({ phase: 'response', reason: 'unsupported-charset', detail: expect.objectContaining({ charset }) }));
    expect(protection.coverage().skipped['response:unsupported-charset']).toBe(1);
  });

  it.each([
    ['a legacy charset over pure ASCII', 'text/html; charset=iso-8859-1'],
    ['a quoted UTF-8 label', 'text/html; charset="UTF-8"'],
    ['an ASCII label', 'text/plain; charset=us-ascii'],
  ])('is screened under %s', async (_label, type) => {
    const { protection, skips } = await guard();
    const out = await protection.screenResponse(new Response(`key ${SAMPLE} end`, { headers: { 'content-type': type } }));

    expect(await out.text()).toBe('key [REDACTED] end');
    expect(skips).toHaveLength(0);
  });

  it('reads a UTF-8 byte-order mark over the declared charset', async () => {
    const { protection, skips } = await guard();
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`key ${SAMPLE}`)]);
    const out = await protection.screenResponse(new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-16' } }));

    expect(await out.text()).toBe('key [REDACTED]');
    expect(skips).toHaveLength(0);
  });

  it('withholds a rewrite that would put non-ASCII into a legacy charset', async () => {
    const { protection } = await guard({ maskWith: '█' });
    const out = await protection.screenResponse(new Response(`key ${SAMPLE}`, { headers: { 'content-type': 'text/plain; charset=iso-8859-1' } }));

    expect(out.status).toBe(500);
  });

  it.each([
    ['a UTF-8 label', 'text/plain; charset=utf-8'],
    ['a quoted UTF-8 label', 'text/plain; charset="UTF-8"'],
    ['no label', 'text/plain'],
  ])('sends a non-ASCII rewrite under %s', async (_label, type) => {
    const { protection } = await guard({ maskWith: '█' });
    const out = await protection.screenResponse(new Response(`key ${SAMPLE}`, { headers: { 'content-type': type } }));

    expect(await out.text()).toBe('key █');
  });
});

describe('escapes in a JSON body (fetch)', () => {
  it('screens a value as a JSON parser reads it', async () => {
    const { protection, detections } = await guard();
    const body = '{"k":"\\u0041KIAIOSFODNN7EXAMPLE","u":"http:\\/\\/10.0.0.1\\/x"}';
    const out = await protection.screenResponse(new Response(body, { headers: { 'content-type': 'application/json' } }));

    expect(await out.json()).toEqual({ k: '[REDACTED]', u: '[REDACTED]/x' });
    expect(detections).toHaveLength(2);
  });

  it('keeps markup-significant escapes escaped in a rewritten body', async () => {
    const { protection } = await guard();
    const body = '{"h":"\\u003cb\\u003e\\u0026\\u0027\\u0022<\\/b>","q":"\\\\","c":"\\u000a\\u001f","n":"caf\\u00e9\\u2028","k":"\\u0041KIAIOSFODNN7EXAMPLE"}';
    const out = await protection.screenResponse(new Response(body, { headers: { 'content-type': 'application/json' } }));
    const text = await out.text();

    expect(text).toBe('{"h":"\\u003cb\\u003e\\u0026\\u0027\\u0022<\\/b>","q":"\\\\","c":"\\u000a\\u001f","n":"caf\\u00e9\\u2028","k":"[REDACTED]"}');
    expect({ ...JSON.parse(text), k: null }).toEqual({ ...JSON.parse(body), k: null });
  });

  it('does not read an escaped backslash as the start of an escape', async () => {
    const { protection, detections } = await guard();
    const body = '{"k":"\\\\u0041KIAIOSFODNN7EXAMPLE"}';
    const original = new Response(body, { headers: { 'content-type': 'application/json' } });
    const out = await protection.screenResponse(original);

    expect(out).toBe(original);
    expect(detections).toHaveLength(0);
  });

  it('sends an unmatched body with its escapes as they were', async () => {
    const { protection } = await guard();
    const body = '{"k":"\\u0041BC","u":"http:\\/\\/example.test"}';
    const original = new Response(body, { headers: { 'content-type': 'application/json' } });

    expect(await protection.screenResponse(original)).toBe(original);
  });

  it('leaves escapes alone in a body that is not JSON', async () => {
    const { protection, detections } = await guard();
    const body = 'k=\\u0041KIAIOSFODNN7EXAMPLE';
    const out = await protection.screenResponse(new Response(body, { headers: { 'content-type': 'text/plain' } }));

    expect(await out.text()).toBe(body);
    expect(detections).toHaveLength(0);
  });
});

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));

  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}

async function rawGet(url: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

describe('character encodings on the Node path', () => {
  async function serve(type: string, body: Buffer | string, viaWriteHead = false, extra: Record<string, unknown> = {}) {
    const g = await guard(extra);
    const node = g.protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        if (viaWriteHead) res.writeHead(200, { 'content-type': type });
        else res.setHeader('content-type', type);
        res.end(body);
      }),
    );

    return { ...g, got: await rawGet(url) };
  }

  it.each([
    ['declared UTF-16', 'application/json; charset=utf-16le', Buffer.from(`{"k":"${SAMPLE}"}`, 'utf16le'), 'utf-16le'],
    ['a UTF-16 byte-order mark', 'application/json', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`{"k":"${SAMPLE}"}`, 'utf16le')]), 'utf-16le'],
    ['a legacy charset with a byte outside ASCII', 'text/html; charset=iso-8859-1', latin1(`café ${SAMPLE}`), 'iso-8859-1'],
  ])('sends a body under %s unchanged and records the skip', async (_label, type, body, charset) => {
    for (const viaWriteHead of [false, true]) {
      const { got, detections, skips } = await serve(type, body, viaWriteHead);

      expect(got.body.equals(body)).toBe(true);
      expect(detections).toHaveLength(0);
      expect(skips).toContainEqual(expect.objectContaining({ reason: 'unsupported-charset', detail: expect.objectContaining({ charset }) }));
      await close?.();
      close = null;
    }
  });

  it('screens a legacy charset over pure ASCII', async () => {
    const { got } = await serve('text/html; charset=iso-8859-1', `key ${SAMPLE} end`);

    expect(got.body.toString('latin1')).toBe('key [REDACTED] end');
  });

  it('withholds a rewrite that would put non-ASCII into a legacy charset', async () => {
    const { got } = await serve('text/plain; charset=iso-8859-1', `key ${SAMPLE}`, false, { maskWith: '█' });

    expect(got.status).toBe(500);
  });

  it('screens a JSON value as a JSON parser reads it', async () => {
    const { got } = await serve('application/json', '{"k":"\\u0041KIAIOSFODNN7EXAMPLE","h":"\\u003cb\\u003e"}');

    expect(got.body.toString()).toBe('{"k":"[REDACTED]","h":"\\u003cb\\u003e"}');
  });
});
