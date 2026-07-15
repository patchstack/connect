import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

const AWS = 'AKIAIOSFODNN7EXAMPLE';
const json = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });

// #2 — response-HEADER screening, and #5 — verbose-error (SQL) suppression.

describe('response-header screening', () => {
  it('redacts a secret matched by a response.header.* rule', async () => {
    const p = await createProtection({
      mode: 'block',
      responseRules: [
        {
          phase: 'response',
          category: 'secret-exposure',
          action: 'redact',
          rule_v2: [{ parameter: 'response.header.x-api-key', match: { type: 'regex', value: '/AKIA[0-9A-Z]{16}/' } }],
        },
      ],
    });
    const res: any = await p.screenResponse(json('{"ok":true}', { 'x-api-key': AWS }));
    expect(res.headers.get('x-api-key')).not.toContain('AKIA');
    expect(res.headers.get('x-api-key')).toContain('[REDACTED]');
  });

  it('masks a secret that also leaks into a header (built-in default rule)', async () => {
    const p = await createProtection({ mode: 'block' }); // default response rules (body-targeted)
    const res: any = await p.screenResponse(json(`{"key":"${AWS}"}`, { 'x-leak': AWS }));
    const body = await res.text();
    expect(body.includes(AWS)).toBe(false); // body redacted (default rule matched)
    expect(res.headers.get('x-leak')).not.toContain('AKIA'); // and the same secret in the header
  });

  it('leaves benign headers untouched', async () => {
    const p = await createProtection({ mode: 'block' });
    const res: any = await p.screenResponse(json('{"ok":true}', { 'x-request-id': 'abc-123' }));
    expect(res.headers.get('x-request-id')).toBe('abc-123');
  });
});

describe('verbose-error suppression (SQL/ORM disclosure)', () => {
  it('redacts a SQL/ORM error signature from the response body', async () => {
    const p = await createProtection({ mode: 'block' });
    const res: any = await p.screenResponse(json('{"error":"SequelizeDatabaseError: relation users does not exist"}', {}));
    const body = await res.text();
    expect(body.includes('SequelizeDatabaseError')).toBe(false);
    expect(body).toContain('[REDACTED]');
  });

  it('leaves a benign error body unchanged', async () => {
    const p = await createProtection({ mode: 'block' });
    const res: any = await p.screenResponse(json('{"error":"Not found"}', {}));
    expect(await res.text()).toContain('Not found');
  });
});
