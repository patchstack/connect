import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * A redaction masks where its condition read. A `response.header.<name>` condition masks that header
 * only — each entry of a multi-valued one — and `response.headers` masks the headers only; neither
 * touches the body. A `response.body` condition masks the body, and the same text in the headers. A rule
 * with conditions on both masks each where it reads.
 */

const emptyBundle = { firewall: [], whitelists: [], whitelist_keys: {} };
const SAMPLE = 'SAMPLE-TOKEN-0123456789';
const PATTERN = { type: 'regex', value: '/SAMPLE-TOKEN-\\d+/' };
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const TOKEN = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ role: 'sample' })}.c2lnbmF0dXJl`;

const rule = (...parameters: string[]) => ({
  id: 'scoped',
  phase: 'response',
  category: 'secret-exposure',
  action: 'redact',
  rule_v2: parameters.map((parameter) => ({ parameter, match: PATTERN })),
});

async function guard(rules: object[], mode = 'block') {
  const detections: any[] = [];
  const protection: any = await createProtection({
    rules: emptyBundle,
    mode,
    responseRules: rules,
    onDetect: (event: any) => detections.push(event),
    onError: () => {},
  });

  return { protection, detections };
}

type Case = {
  label: string;
  rules: object[];
  body: string;
  headers: Record<string, string>;
  status: number;
  expectBody: string;
  expectHeaders: Record<string, string>;
};

const cases: Case[] = [
  {
    label: 'a header rule leaves the body alone',
    rules: [rule('response.header.x-sample')],
    body: `{"note":"${SAMPLE}"}`,
    headers: { 'x-sample': SAMPLE },
    status: 200,
    expectBody: `{"note":"${SAMPLE}"}`,
    expectHeaders: { 'x-sample': '[REDACTED]' },
  },
  {
    label: 'a header rule leaves an unrelated header alone',
    rules: [rule('response.header.x-sample')],
    body: '{"ok":true}',
    headers: { 'x-sample': SAMPLE, 'x-other': SAMPLE },
    status: 200,
    expectBody: '{"ok":true}',
    expectHeaders: { 'x-sample': '[REDACTED]', 'x-other': SAMPLE },
  },
  {
    label: 'a header rule leaves a JSON key alone',
    rules: [rule('response.header.x-sample')],
    body: `{"${SAMPLE}":1}`,
    headers: { 'x-sample': SAMPLE },
    status: 200,
    expectBody: `{"${SAMPLE}":1}`,
    expectHeaders: { 'x-sample': '[REDACTED]' },
  },
  {
    label: 'an all-headers rule masks every header and not the body',
    rules: [rule('response.headers')],
    body: `{"note":"${SAMPLE}"}`,
    headers: { 'x-sample': SAMPLE, 'x-other': SAMPLE },
    status: 200,
    expectBody: `{"note":"${SAMPLE}"}`,
    expectHeaders: { 'x-sample': '[REDACTED]', 'x-other': '[REDACTED]' },
  },
  {
    label: 'a body rule masks the body, and the same text in the headers',
    rules: [rule('response.body')],
    body: `{"note":"${SAMPLE}"}`,
    headers: { 'x-sample': SAMPLE },
    status: 200,
    expectBody: '{"note":"[REDACTED]"}',
    expectHeaders: { 'x-sample': '[REDACTED]' },
  },
  {
    label: 'a rule on a header and the body masks both',
    rules: [rule('response.header.x-sample', 'response.body')],
    body: `{"note":"${SAMPLE}"}`,
    headers: { 'x-sample': SAMPLE, 'x-other': SAMPLE },
    status: 200,
    expectBody: '{"note":"[REDACTED]"}',
    expectHeaders: { 'x-sample': '[REDACTED]', 'x-other': '[REDACTED]' },
  },
];

describe('redaction scope (fetch)', () => {
  it.each(cases)('$label', async ({ rules, body, headers, status, expectBody, expectHeaders }) => {
    const { protection } = await guard(rules);
    const out = await protection.screenResponse(new Response(body, { headers: { 'content-type': 'application/json', ...headers } }));

    expect(out.status).toBe(status);
    expect(await out.text()).toBe(expectBody);
    for (const [name, value] of Object.entries(expectHeaders)) expect(out.headers.get(name)).toBe(value);
  });

  it('masks a header rule entry by entry on a multi-valued header', async () => {
    const { protection } = await guard([rule('response.header.set-cookie')]);
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', `a=${SAMPLE}`);
    headers.append('set-cookie', 'b=plain');
    headers.append('x-other', SAMPLE);
    const out = await protection.screenResponse(new Response(`{"note":"${SAMPLE}"}`, { headers }));

    expect(out.headers.getSetCookie()).toEqual(['a=[REDACTED]', 'b=plain']);
    expect(out.headers.get('x-other')).toBe(SAMPLE);
    expect(await out.text()).toBe(`{"note":"${SAMPLE}"}`);
  });

  it('encodes the body only for a rule on the body', async () => {
    const encode = (parameter: string) => ({ ...rule(parameter), action: 'encode', rule_v2: [{ parameter, match: { type: 'contains', value: '<b>' } }] });
    const body = JSON.stringify({ note: '<b>x</b>' });
    for (const [parameter, expected] of [['response.header.x-sample', body], ['response.body', JSON.stringify({ note: '&lt;b&gt;x</b>' })]]) {
      const { protection } = await guard([encode(parameter)]);
      const out = await protection.screenResponse(new Response(body, { headers: { 'content-type': 'application/json', 'x-sample': '<b>' } }));

      expect(await out.text()).toBe(expected);
      expect(out.headers.get('x-sample')).toBe('<b>');
    }
  });

  it.each([
    ['a mixed-case header name', { parameter: 'response.header.X-Sample', match: PATTERN }, SAMPLE],
    ['a literal match', { parameter: 'response.header.x-sample', match: { type: 'contains', value: SAMPLE } }, SAMPLE],
    ['a token claim', { parameter: 'response.header.x-sample', match: { type: 'jwt_claim_equals', claim: 'role', value: 'sample' } }, TOKEN],
  ])('keeps %s to its header', async (_label, condition, value) => {
    const { protection } = await guard([{ ...rule(), rule_v2: [condition] }]);
    const out = await protection.screenResponse(new Response(`{"note":"${value}"}`, {
      headers: { 'content-type': 'application/json', 'x-sample': value, 'x-other': value },
    }));

    expect(out.headers.get('x-sample')).not.toContain(value);
    expect(out.headers.get('x-other')).toBe(value);
    expect(await out.text()).toBe(`{"note":"${value}"}`);
  });

  it('keeps the scope when the body is not screened', async () => {
    const { protection } = await guard([rule('response.header.x-sample')]);
    const out = await protection.screenResponse(new Response(new Uint8Array([0x89, 0x50, 0x00, 0x01]), {
      headers: { 'content-type': 'image/png', 'x-sample': SAMPLE, 'x-other': SAMPLE },
    }));

    expect(out.headers.get('x-sample')).toBe('[REDACTED]');
    expect(out.headers.get('x-other')).toBe(SAMPLE);
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

describe('redaction scope (Node)', () => {
  async function serve(rules: object[], type: string, headers: Record<string, string>, body: string | Buffer, flush: boolean) {
    const g = await guard(rules);
    const node = g.protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', type);
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        if (flush) res.flushHeaders();
        res.end(body);
      }),
    );

    return { ...g, got: await rawGet(url) };
  }

  it.each(cases)('$label', async ({ rules, body, headers, status, expectBody, expectHeaders }) => {
    const { got } = await serve(rules, 'application/json', headers, body, false);

    expect(got.status).toBe(status);
    expect(got.body.toString()).toBe(expectBody);
    for (const [name, value] of Object.entries(expectHeaders)) expect(got.headers[name]).toBe(value);
  });

  it.each([
    ['an early flush', 'text/plain', 'plain text', true],
    ['a body that is not screened', 'image/png', Buffer.from([0x89, 0x50, 0x00, 0x01]), false],
  ])('keeps a header rule to its header on %s', async (_label, type, body, flush) => {
    const { got, detections } = await serve([rule('response.header.x-sample')], type, { 'x-sample': SAMPLE, 'x-other': SAMPLE }, body, flush);

    expect(got.headers['x-sample']).toBe('[REDACTED]');
    expect(got.headers['x-other']).toBe(SAMPLE);
    expect(detections).toHaveLength(1);
  });

  it('masks a header rule entry by entry on a multi-valued header', async () => {
    const g = await guard([rule('response.header.set-cookie')]);
    const node = g.protection.node({ screenResponses: true });
    const url = await listen((req, res) =>
      node(req, res, () => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('set-cookie', [`a=${SAMPLE}`, 'b=plain']);
        res.setHeader('x-other', SAMPLE);
        res.end(`{"note":"${SAMPLE}"}`);
      }),
    );
    const got = await rawGet(url);

    expect(got.headers['set-cookie']).toEqual(['a=[REDACTED]', 'b=plain']);
    expect(got.headers['x-other']).toBe(SAMPLE);
    expect(got.body.toString()).toBe(`{"note":"${SAMPLE}"}`);
  });
});
