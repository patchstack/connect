import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * A redaction's scope does not depend on how its parameter is written. A list masks the union of its
 * members' scopes, a single-item list masks what the string does, and a condition inside a group masks
 * where it reads. The same holds on every path a response can take: screened on fetch or Node, with the
 * head flushed early, or with a body that is not screened.
 */

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
const SAMPLE = 'SAMPLE-TOKEN-0123456789';
const PATTERN = { type: 'regex', value: '/SAMPLE-TOKEN-\\d+/' };
const HEADERS = { 'x-sample': SAMPLE, 'x-extra': SAMPLE, 'x-other': SAMPLE };
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);

type Form = { label: string; condition: Record<string, unknown>; masked: string[]; readsBody: boolean };

const leaf = (parameter: unknown) => ({ parameter, match: PATTERN });
const forms: Form[] = [
  { label: 'a header, as a string', condition: leaf('response.header.x-sample'), masked: ['x-sample'], readsBody: false },
  { label: 'a header, as a one-item list', condition: leaf(['response.header.x-sample']), masked: ['x-sample'], readsBody: false },
  { label: 'two headers, as a list', condition: leaf(['response.header.x-sample', 'response.header.X-Extra']), masked: ['x-sample', 'x-extra'], readsBody: false },
  { label: 'all headers, as a string', condition: leaf('response.headers'), masked: ['x-sample', 'x-extra', 'x-other'], readsBody: false },
  { label: 'all headers, as a list', condition: leaf(['response.headers']), masked: ['x-sample', 'x-extra', 'x-other'], readsBody: false },
  { label: 'a header beside a nested list, which reads nothing', condition: leaf(['response.header.x-sample', ['response.body']]), masked: ['x-sample'], readsBody: false },
  { label: 'a header list in a group', condition: { parameter: 'rules', rules: [leaf(['response.header.x-sample'])] }, masked: ['x-sample'], readsBody: false },
  { label: 'the body, as a one-item list', condition: leaf(['response.body']), masked: ['x-sample', 'x-extra', 'x-other'], readsBody: true },
  { label: 'the body and a header, as a list', condition: leaf(['response.body', 'response.header.x-sample']), masked: ['x-sample', 'x-extra', 'x-other'], readsBody: true },
];

const ruleOf = (condition: Record<string, unknown>) => ({
  id: 'scoped',
  phase: 'response',
  category: 'secret-exposure',
  action: 'redact',
  rule_v2: [condition],
});

async function guard(condition: Record<string, unknown>) {
  const detections: any[] = [];
  const protection: any = await createProtection({
    rules: emptyBundle,
    mode: 'block',
    responseRules: [ruleOf(condition)],
    onDetect: (event: any) => detections.push(event),
    onError: () => {},
  });

  return { protection, detections };
}

type Seen = { status: number; body: Buffer; headers: Record<string, string | null> };

const seenHeaders = (get: (name: string) => string | null | undefined) =>
  Object.fromEntries(Object.keys(HEADERS).map((name) => [name, get(name) ?? null]));

async function viaFetch(condition: Record<string, unknown>, body: string | Buffer, type: string): Promise<Seen> {
  const { protection } = await guard(condition);
  const out = await protection.screenResponse(new Response(body, { headers: { 'content-type': type, ...HEADERS } }));

  return { status: out.status, body: Buffer.from(await out.arrayBuffer()), headers: seenHeaders((n) => out.headers.get(n)) };
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function viaNode(condition: Record<string, unknown>, body: string | Buffer, type: string, flush: boolean): Promise<Seen> {
  const { protection } = await guard(condition);
  const node = protection.node({ screenResponses: true });
  const server = createServer((req: IncomingMessage, res: ServerResponse) =>
    node(req, res, () => {
      res.setHeader('content-type', type);
      for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
      if (flush) res.flushHeaders();
      res.end(body);
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  const { request } = await import('node:http');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

  return new Promise((resolve, reject) => {
    request(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const got = res.headers;
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: seenHeaders((n) => got[n] as string | undefined) });
      });
    }).on('error', reject).end();
  });
}

const expectedHeaders = (masked: string[]) =>
  Object.fromEntries(Object.keys(HEADERS).map((name) => [name, masked.includes(name) ? '[REDACTED]' : SAMPLE]));

describe.each([
  ['fetch', (c: Record<string, unknown>, b: string | Buffer, t: string) => viaFetch(c, b, t)],
  ['Node', (c: Record<string, unknown>, b: string | Buffer, t: string) => viaNode(c, b, t, false)],
])('parameter forms on a screened body (%s)', (_path, run) => {
  it.each(forms)('$label', async ({ condition, masked, readsBody }) => {
    const body = `{"note":"${SAMPLE}"}`;
    const got = await run(condition, body, 'application/json');

    expect(got.status).toBe(200);
    expect(got.body.toString()).toBe(readsBody ? '{"note":"[REDACTED]"}' : body);
    expect(got.headers).toEqual(expectedHeaders(masked));
  });

  it.each(forms.filter((f) => !f.readsBody))('$label leaves a JSON key alone', async ({ condition, masked }) => {
    const body = `{"${SAMPLE}":1}`;
    const got = await run(condition, body, 'application/json');

    expect(got.status).toBe(200);
    expect(got.body.toString()).toBe(body);
    expect(got.headers).toEqual(expectedHeaders(masked));
  });
});

describe.each([
  ['fetch, a body that is not screened', (c: Record<string, unknown>) => viaFetch(c, BINARY, 'image/png')],
  ['Node, a body that is not screened', (c: Record<string, unknown>) => viaNode(c, BINARY, 'image/png', false)],
  ['Node, an early flush', (c: Record<string, unknown>) => viaNode(c, 'plain text', 'text/plain', true)],
])('header-only parameter forms (%s)', (_path, run) => {
  it.each(forms.filter((f) => !f.readsBody))('$label', async ({ condition, masked }) => {
    const got = await run(condition);

    expect(got.status).toBe(200);
    expect(got.headers).toEqual(expectedHeaders(masked));
  });
});

describe('a condition that names no place in the response', () => {
  it.each([
    ['no parameter', undefined],
    ['the status', 'response.status'],
    ['a request source', 'get.q'],
  ])('keeps the widest scope with %s', async (_label, parameter) => {
    const extra = { ...(parameter === undefined ? {} : { parameter }), match: { type: 'regex', value: '/EXTRA-\\d+/' } };
    const detections: any[] = [];
    const protection: any = await createProtection({
      rules: emptyBundle,
      mode: 'block',
      responseRules: [{ ...ruleOf(leaf('response.body')), rule_v2: [leaf('response.body'), extra] }],
      onDetect: (event: any) => detections.push(event),
    });
    const out = await protection.screenResponse(new Response(`{"note":"${SAMPLE}","more":"EXTRA-1"}`, {
      headers: { 'content-type': 'application/json', 'x-other': 'EXTRA-1' },
    }));

    expect(JSON.parse(await out.text())).toEqual({ note: '[REDACTED]', more: '[REDACTED]' });
    expect(out.headers.get('x-other')).toBe('[REDACTED]');
  });
});

describe('structural masking with a parameter list', () => {
  it('masks a JSON path read through a one-item list', async () => {
    const condition = { parameter: ['response.body'], mutations: ['json_decode'], match: { type: 'array_key_value', key: 'note', match: { type: 'isset' } } };
    const got = await viaFetch(condition, `{"note":"${SAMPLE}","other":1}`, 'application/json');

    expect(got.status).toBe(200);
    expect(JSON.parse(got.body.toString())).toEqual({ note: '[REDACTED]', other: 1 });
  });
});
