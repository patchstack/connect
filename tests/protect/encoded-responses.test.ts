import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { brotliCompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * A response body that is content-encoded cannot be read as text, so the response phase cannot screen
 * it. That is recorded as a skip — visible through `onSkip` and `coverage()` — and the response goes
 * out exactly as it was: the same bytes, under the same encoding.
 *
 * "Encoded" is judged from the bytes as well as the header. `fetch()` decodes a compressed response but
 * keeps its `Content-Encoding` header, so a proxied response can declare gzip and carry plain text;
 * that body is readable, and is screened like any other.
 */

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
const SECRET = 'AKIAABCDEFGHIJKLMNOP';
const payload = JSON.stringify({ k: SECRET });

type Skip = { phase: string; reason: string; detail?: Record<string, unknown> };

async function guard(extra: Record<string, unknown> = {}) {
  const skips: Skip[] = [];
  const protection: any = await createProtection({ rules: emptyBundle, mode: 'block', onError: () => {}, onSkip: (s: Skip) => skips.push(s), ...extra });

  return { protection, skips };
}

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

/** The response exactly as it arrived on the wire, without the client decoding it. */
async function rawGet(url: string): Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

describe('an encoded body on the Node path', () => {
  it.each([
    ['gzip', gzipSync(payload)],
    ['br', brotliCompressSync(payload)],
  ])('is passed through unchanged under %s, and the skip is recorded', async (encoding, encoded) => {
    const { protection, skips } = await guard();
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('content-encoding', encoding);
        res.end(encoded);
      }),
    );

    const { headers, body } = await rawGet(url);
    expect(headers['content-encoding']).toBe(encoding);
    expect(body.equals(encoded)).toBe(true);
    expect(skips).toContainEqual(expect.objectContaining({ phase: 'response', reason: 'encoded-body', detail: expect.objectContaining({ encoding }) }));
    expect(protection.coverage().skipped['response:encoded-body']).toBe(1);
  });

  it.each([
    ['with nothing set before', false],
    ['beside headers set before', true],
  ])('is recognised when writeHead alone declares the coding, %s', async (_label, setBefore) => {
    // `writeHead` is held until the body is written, and without earlier headers Node keeps what it is
    // given out of the response's header state — so the coding is read from the head that will be sent.
    const { protection, skips } = await guard();
    const node = protection.node({ screenResponses: true });
    const encoded = gzipSync(payload);
    const url = await listen((req, res) =>
      node(req, res, () => {
        if (setBefore) res.setHeader('x-app', '1');
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(encoded);
      }),
    );

    const { headers, body } = await rawGet(url);
    expect(headers['content-encoding']).toBe('gzip');
    expect(body.equals(encoded)).toBe(true);
    expect(skips).toContainEqual(expect.objectContaining({ reason: 'encoded-body', detail: { encoding: 'gzip' } }));
  });

  it('is still hardened where hardening needs no body', async () => {
    const { protection } = await guard({
      rules: {
        ...emptyBundle,
        firewall: [{ id: 1, phase: 'response', action: 'set-header', set_headers: { 'x-frame-options': 'DENY' }, rule_v2: [{ parameter: 'response.status', match: { type: 'isset' } }] }],
      },
    });
    const node = protection.node({ screenResponses: true });
    const encoded = gzipSync(payload);
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('content-encoding', 'gzip');
        res.end(encoded);
      }),
    );

    const { headers, body } = await rawGet(url);
    expect(headers['x-frame-options']).toBe('DENY');
    expect(gunzipSync(body).toString()).toBe(payload);
  });

  it('is screened when the declared coding does not match the bytes', async () => {
    // Declared gzip, written as plain text: the bytes are readable, so they are screened like any
    // other body rather than passed through on the strength of the header.
    const { protection, skips } = await guard();
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('content-encoding', 'gzip');
        res.end(payload);
      }),
    );

    const { body } = await rawGet(url);
    expect(body.toString()).not.toContain(SECRET);
    expect(skips.filter((s) => s.reason === 'encoded-body')).toEqual([]);
  });

  it('reports the codings actually applied', async () => {
    const { protection, skips } = await guard();
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('content-encoding', 'identity, gzip');
        res.end(gzipSync(payload));
      }),
    );

    await rawGet(url);
    expect(skips).toContainEqual(expect.objectContaining({ reason: 'encoded-body', detail: { encoding: 'gzip' } }));
  });

  it('is screened as usual when the declared coding is identity', async () => {
    const { protection, skips } = await guard();
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('content-encoding', 'identity');
        res.end(payload);
      }),
    );

    const { body } = await rawGet(url);
    expect(body.toString()).not.toContain(SECRET);
    expect(skips.filter((s) => s.reason === 'encoded-body')).toEqual([]);
  });
});

describe('an encoded body on the fetch path', () => {
  it('is handed back untouched, and the skip is recorded', async () => {
    const { protection, skips } = await guard();
    const encoded = gzipSync(payload);
    const response = new Response(encoded, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });

    const screened: Response = await protection.screenResponse(response);
    expect(screened.headers.get('content-encoding')).toBe('gzip');
    expect(Buffer.from(await screened.arrayBuffer()).equals(encoded)).toBe(true);
    expect(skips).toContainEqual(expect.objectContaining({ phase: 'response', reason: 'encoded-body', detail: expect.objectContaining({ encoding: 'gzip' }) }));
  });

  it('is screened when fetch() has already decoded it, whatever the header says', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(payload));
    });
    const upstream = await fetch(url);
    expect(upstream.headers.get('content-encoding')).toBe('gzip'); // the premise of the case

    const { protection, skips } = await guard();
    const screened: Response = await protection.screenResponse(upstream);
    expect(await screened.text()).not.toContain(SECRET);
    expect(skips.filter((s) => s.reason === 'encoded-body')).toEqual([]);
  });
});
