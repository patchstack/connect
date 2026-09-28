import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * A `block` rule that reads response headers alone is decided without the body, so it is enforced on a
 * response whose body was not screened — over the cap, binary, a live stream, or content-encoded — as
 * long as the head has not gone out. When it has, the match is reported and the limitation is recorded
 * as a `headers-sent` skip. A rule that reads the body, or has no explicit `block` action, is left out
 * when there is no body.
 */

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
const SAMPLE = 'SAMPLE-TOKEN-0123456789';
const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
const WITHHELD = { error: 'Response withheld by Patchstack (sensitive data detected)' };

const blockRule = (extra: Record<string, unknown> = {}) => ({
  id: 'header-block',
  phase: 'response',
  category: 'secret-exposure',
  action: 'block',
  rule_v2: [{ parameter: 'response.header.x-sample', match: { type: 'regex', value: '/SAMPLE-TOKEN-\\d+/' } }],
  ...extra,
});

async function guard(rules: object[], mode = 'block') {
  const detections: any[] = [];
  const skips: any[] = [];
  const protection: any = await createProtection({
    rules: emptyBundle,
    mode,
    responseRules: rules,
    onDetect: (event: any) => detections.push(event),
    onSkip: (skip: any) => skips.push(skip),
    onError: () => {},
  });

  return { protection, detections, skips };
}

const unscreened: Array<[string, () => Response]> = [
  ['a binary body', () => new Response(BINARY, { headers: { 'content-type': 'image/png', 'x-sample': SAMPLE } })],
  ['a body over the cap', () => new Response('x'.repeat(600 * 1024), { headers: { 'content-type': 'text/plain', 'x-sample': SAMPLE } })],
  ['a live stream', () => new Response('data: 1\n\n', { headers: { 'content-type': 'text/event-stream', 'x-sample': SAMPLE } })],
  ['an encoded body', () => new Response(gzipSync('{"a":1}'), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-sample': SAMPLE } })],
];

describe('a header block when the body is not screened (fetch)', () => {
  it.each(unscreened)('withholds %s', async (_label, make) => {
    const { protection, detections } = await guard([blockRule()]);
    const out = await protection.screenResponse(make());

    expect(out.status).toBe(500);
    expect(await out.json()).toEqual(WITHHELD);
    expect(out.headers.get('x-sample')).toBeNull();
    expect(detections).toHaveLength(1);
  });

  it('wins over a header redaction on the same response', async () => {
    const redact = { ...blockRule(), id: 'header-redact', action: 'redact' };
    const { protection, detections } = await guard([redact, blockRule()]);
    const out = await protection.screenResponse(unscreened[0][1]());

    expect(out.status).toBe(500);
    expect(detections).toHaveLength(2);
  });

  it('records the match in dry-run and sends the response', async () => {
    const { protection, detections } = await guard([blockRule()], 'dry-run');
    const original = unscreened[0][1]();

    expect(await protection.screenResponse(original)).toBe(original);
    expect(detections).toHaveLength(1);
  });

  it.each([
    ['one that reads the body', { rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/SAMPLE-TOKEN-\\d+/' } }] }],
    ['one that reads the body beside a header', { rule_v2: [
      { parameter: 'response.header.x-sample', match: { type: 'regex', value: '/SAMPLE-TOKEN-\\d+/' } },
      { parameter: 'response.body', match: { type: 'regex', value: '/SAMPLE-TOKEN-\\d+/' } },
    ] }],
    ['one with no explicit action', { action: undefined }],
  ])('leaves out %s', async (_label, shape) => {
    const { protection, detections } = await guard([blockRule(shape)]);
    const original = unscreened[0][1]();

    expect(await protection.screenResponse(original)).toBe(original);
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

describe('a header block when the body is not screened (Node)', () => {
  const bodies: Array<[string, string, Buffer, Record<string, string>]> = [
    ['a binary body', 'image/png', Buffer.from(BINARY), {}],
    ['a sniffed binary body', 'application/octet-stream', Buffer.from(BINARY), {}],
    ['an encoded body', 'application/json', gzipSync('{"a":1}'), { 'content-encoding': 'gzip' }],
    ['a body over the cap', 'text/plain', Buffer.from('x'.repeat(600 * 1024)), {}],
  ];

  function expectWithheld(got: { status: number; headers: Record<string, unknown>; body: Buffer }) {
    expect(got.status).toBe(500);
    expect(Number(got.headers['content-length'])).toBe(got.body.length);
    expect(JSON.parse(got.body.toString())).toEqual(WITHHELD);
    expect(got.headers['x-sample']).toBeUndefined();
    expect(got.headers['content-encoding']).toBeUndefined();
  }

  it.each(bodies)('withholds %s, headers set before the body', async (_label, type, body, extra) => {
    const { protection, detections } = await guard([blockRule()]);
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', type);
        for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
        res.setHeader('x-sample', SAMPLE);
        res.end(body);
      }),
    );

    expectWithheld(await rawGet(url));
    expect(detections).toHaveLength(1);
  });

  it.each(bodies)('withholds %s, headers supplied through writeHead', async (_label, type, body, extra) => {
    const { protection, detections } = await guard([blockRule()]);
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.writeHead(200, 'OK', { 'content-type': type, 'x-sample': SAMPLE, ...extra });
        res.end(body);
      }),
    );

    expectWithheld(await rawGet(url));
    expect(detections).toHaveLength(1);
  });

  it('withholds a body that crosses the cap across writes, and drops what follows', async () => {
    const { protection, detections } = await guard([blockRule()]);
    const node = protection.node({ screenResponses: true });
    const errors: unknown[] = [];
    const written: boolean[] = [];
    const ended = new Promise<void>((resolve) => {
      void listen((req, res) =>
        node(req, res, () => {
          res.on('error', (error) => errors.push(error));
          res.setHeader('content-type', 'text/plain');
          res.setHeader('x-sample', SAMPLE);
          for (let i = 0; i < 4; i++) written.push(res.write('x'.repeat(200 * 1024)));
          res.end('tail', () => resolve());
        }),
      ).then((url) => rawGet(url).then((got) => {
        expectWithheld(got);
      }));
    });

    await ended;
    expect(errors).toEqual([]);
    expect(written.every(Boolean)).toBe(true);
    expect(detections).toHaveLength(1);
  });

  it('completes the application\'s end once when the cap is crossed by its final chunk', async () => {
    const { protection } = await guard([blockRule()]);
    const node = protection.node({ screenResponses: true });
    const calls: unknown[] = [];
    const errors: unknown[] = [];
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.on('error', (error) => errors.push(error));
        res.setHeader('content-type', 'text/plain');
        res.setHeader('x-sample', SAMPLE);
        res.end('x'.repeat(600 * 1024), (error?: unknown) => calls.push(error ?? null));
      }),
    );

    expectWithheld(await rawGet(url));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([null]);
    expect(errors).toEqual([]);
  });

  it('reports a match whose head had already gone, and records that it could not be enforced', async () => {
    const { protection, detections, skips } = await guard([blockRule()]);
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', 'image/png');
        res.setHeader('x-sample', SAMPLE);
        res.flushHeaders();
        res.end(Buffer.from(BINARY));
      }),
    );

    const got = await rawGet(url);
    expect(got.status).toBe(200);
    expect(got.body.equals(Buffer.from(BINARY))).toBe(true);
    expect(detections).toHaveLength(1);
    expect(skips).toContainEqual(expect.objectContaining({ reason: 'headers-sent', detail: { action: 'block' } }));
  });

  it('leaves the response alone in dry-run', async () => {
    const { protection, detections } = await guard([blockRule()], 'dry-run');
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', 'image/png');
        res.setHeader('x-sample', SAMPLE);
        res.end(Buffer.from(BINARY));
      }),
    );

    const got = await rawGet(url);
    expect(got.status).toBe(200);
    expect(got.body.equals(Buffer.from(BINARY))).toBe(true);
    expect(detections).toHaveLength(1);
  });

  it('withholds a screened text response once', async () => {
    const { protection, detections } = await guard([blockRule()]);
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-sample', SAMPLE);
        res.end('{"ok":true}');
      }),
    );

    expectWithheld(await rawGet(url));
    expect(detections).toHaveLength(1);
  });
});
