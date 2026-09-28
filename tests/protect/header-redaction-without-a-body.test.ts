import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * A redaction keyed on a response header reads the header alone, so it is decided — and carried out —
 * whether or not the body was screened: over the cap, binary, a live stream, or content-encoded. A rule
 * that reads the body is still left out when there is no body to read.
 *
 * A rule's `prefilter` anchors are looked for in the header values as well as the body, since a rule
 * may read either.
 */

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
const SAMPLE = 'SAMPLE-TOKEN-0123456789';
const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);

const headerRule = (extra: Record<string, unknown> = {}) => ({
  id: 'header-value',
  phase: 'response',
  category: 'secret-exposure',
  action: 'redact',
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

describe('a header redaction when the body is not screened (fetch)', () => {
  it.each([
    ['a binary body', () => new Response(BINARY, { headers: { 'content-type': 'image/png', 'x-sample': SAMPLE } }), 'non-text-content-type'],
    ['a body over the cap', () => new Response('x'.repeat(600 * 1024), { headers: { 'content-type': 'text/plain', 'x-sample': SAMPLE } }), 'body-cap'],
    ['a live stream', () => new Response('data: 1\n\n', { headers: { 'content-type': 'text/event-stream', 'x-sample': SAMPLE } }), 'live-stream'],
    ['an encoded body', () => new Response(gzipSync('{"a":1}'), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-sample': SAMPLE } }), 'encoded-body'],
  ])('masks the header on %s and leaves the body alone', async (_label, make, reason) => {
    const { protection, detections, skips } = await guard([headerRule()]);
    const original = make();
    const expected = new Uint8Array(await original.clone().arrayBuffer());
    const out = await protection.screenResponse(original);

    expect(out.headers.get('x-sample')).toBe('[REDACTED]');
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(expected);
    expect(detections).toHaveLength(1);
    expect(skips.map((s: any) => s.reason)).toContain(reason);
  });

  it('records the match in dry-run without changing the header', async () => {
    const { protection, detections } = await guard([headerRule()], 'dry-run');
    const out = await protection.screenResponse(new Response(BINARY, { headers: { 'content-type': 'image/png', 'x-sample': SAMPLE } }));

    expect(out.headers.get('x-sample')).toBe(SAMPLE);
    expect(detections).toHaveLength(1);
  });

  it.each([
    ['one that reads the body', { rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/SAMPLE-TOKEN-\\d+/' } }] }],
    ['one that reads the status alone', { rule_v2: [{ parameter: 'response.status', match: { type: 'contains', value: '200' } }] }],
    ['one that reads the body beside a header', { rule_v2: [
      { parameter: 'response.header.x-sample', match: { type: 'regex', value: '/SAMPLE-TOKEN-\\d+/' } },
      { parameter: 'response.body', match: { type: 'regex', value: '/SAMPLE-TOKEN-\\d+/' } },
    ] }],
    ['an encoding rule', { action: 'encode' }],
    ['one whose match is decoded first', { rule_v2: [{ parameter: 'response.header.x-sample', mutations: ['urldecode'], match: { type: 'contains', value: SAMPLE } }] }],
    ['one with no span to mask', { rule_v2: [{ parameter: 'response.header.x-sample', match: { type: 'isset' } }] }],
  ])('leaves out %s', async (_label, shape) => {
    const { protection, detections } = await guard([headerRule(shape)]);
    const original = new Response(BINARY, { headers: { 'content-type': 'image/png', 'x-sample': SAMPLE } });
    const out = await protection.screenResponse(original);

    expect(out).toBe(original);
    expect(detections).toHaveLength(0);
  });
});

describe('a prefilter on a header redaction (fetch)', () => {
  it.each([
    ['a screened body', () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json', 'x-sample': SAMPLE } })],
    ['an unscreened body', () => new Response(BINARY, { headers: { 'content-type': 'image/png', 'x-sample': SAMPLE } })],
  ])('finds its anchor in the header value with %s', async (_label, make) => {
    const { protection, detections } = await guard([headerRule({ prefilter: ['sample-token'] })]);
    const out = await protection.screenResponse(make());

    expect(out.headers.get('x-sample')).toBe('[REDACTED]');
    expect(detections).toHaveLength(1);
  });

  it('still skips the rule when the anchor is nowhere in the response', async () => {
    const { protection, detections } = await guard([headerRule({ prefilter: ['absent-anchor'] })]);
    const out = await protection.screenResponse(new Response('{"ok":true}', { headers: { 'content-type': 'application/json', 'x-sample': SAMPLE } }));

    expect(out.headers.get('x-sample')).toBe(SAMPLE);
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

describe('a header redaction when the body is not screened (Node)', () => {
  const bodies: Array<[string, string, Buffer, Record<string, string>, string]> = [
    ['a binary body', 'image/png', Buffer.from(BINARY), {}, 'non-text-content-type'],
    ['a sniffed binary body', 'application/octet-stream', Buffer.from(BINARY), {}, 'binary-body'],
    ['an encoded body', 'application/json', gzipSync('{"a":1}'), { 'content-encoding': 'gzip' }, 'encoded-body'],
    ['a body over the cap', 'text/plain', Buffer.from('x'.repeat(600 * 1024)), {}, 'body-cap'],
  ];

  it.each(bodies)('masks the header on %s, set before the body', async (_label, type, body, extra, reason) => {
    const { protection, detections, skips } = await guard([headerRule()]);
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', type);
        for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
        res.setHeader('x-sample', SAMPLE);
        res.end(body);
      }),
    );

    const got = await rawGet(url);
    expect(got.headers['x-sample']).toBe('[REDACTED]');
    expect(got.body.equals(body)).toBe(true);
    expect(detections).toHaveLength(1);
    expect(skips.map((s: any) => s.reason)).toContain(reason);
  });

  it.each(bodies)('masks the header on %s, supplied through writeHead', async (_label, type, body, extra) => {
    const { protection, detections } = await guard([headerRule()]);
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.writeHead(200, { 'content-type': type, 'x-sample': SAMPLE, ...extra });
        res.end(body);
      }),
    );

    const got = await rawGet(url);
    expect(got.headers['x-sample']).toBe('[REDACTED]');
    expect(got.body.equals(body)).toBe(true);
    expect(detections).toHaveLength(1);
  });

  it('reports a match whose header had already gone, and records that it could not be masked', async () => {
    const { protection, detections, skips } = await guard([headerRule()]);
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
    expect(got.headers['x-sample']).toBe(SAMPLE);
    expect(got.body.equals(Buffer.from(BINARY))).toBe(true);
    expect(detections).toHaveLength(1);
    expect(skips).toContainEqual(expect.objectContaining({ reason: 'headers-sent', detail: { headers: ['x-sample'] } }));
  });

  it('reports a screened text response once', async () => {
    const { protection, detections } = await guard([headerRule()]);
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-sample', SAMPLE);
        res.end('{"ok":true}');
      }),
    );

    const got = await rawGet(url);
    expect(got.headers['x-sample']).toBe('[REDACTED]');
    expect(got.body.toString()).toBe('{"ok":true}');
    expect(detections).toHaveLength(1);
  });

  it('leaves the header alone in dry-run', async () => {
    const { protection, detections } = await guard([headerRule()], 'dry-run');
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', 'image/png');
        res.setHeader('x-sample', SAMPLE);
        res.end(Buffer.from(BINARY));
      }),
    );

    const got = await rawGet(url);
    expect(got.headers['x-sample']).toBe(SAMPLE);
    expect(detections).toHaveLength(1);
  });

  it('finds a prefilter anchor in the header value', async () => {
    const { protection, detections } = await guard([headerRule({ prefilter: ['sample-token'] })]);
    const node = protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-sample', SAMPLE);
        res.end('{"ok":true}');
      }),
    );

    const got = await rawGet(url);
    expect(got.headers['x-sample']).toBe('[REDACTED]');
    expect(detections).toHaveLength(1);
  });
});
