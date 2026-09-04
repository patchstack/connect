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

  it('redacts a secret across multi-valued Set-Cookie headers, re-emitting each cookie', async () => {
    const p = await createProtection({ mode: 'block' }); // default AWS body rule supplies the redactor
    const headers = new Headers([
      ['content-type', 'application/json'],
      ['set-cookie', 'sid=abc123; HttpOnly'],
      ['set-cookie', `token=${AWS}; Secure`],
    ]);
    const res: any = await p.screenResponse(new Response(`{"leaked":"${AWS}"}`, { status: 200, headers }));
    const cookies = res.headers.getSetCookie?.() ?? [];
    expect(cookies.length).toBe(2); // both cookies preserved
    expect(cookies.some((c: string) => c.includes('AKIA'))).toBe(false); // secret masked in the array
    expect(cookies.some((c: string) => c.includes('sid=abc123'))).toBe(true); // benign cookie intact
  });
});

describe('verbose-error suppression — backend exceptions/tracebacks', () => {
  it('redacts a Python traceback and a JVM stack frame', async () => {
    const p = await createProtection({ mode: 'block' });
    const py: any = await p.screenResponse(json('{"e":"Traceback (most recent call last): File x"}'));
    expect((await py.text()).includes('Traceback (most recent call last)')).toBe(false);
    const jvm: any = await p.screenResponse(json('{"e":"... at com.acme.Svc(Svc.java:42) ..."}'));
    expect((await jvm.text()).includes('Svc.java:42')).toBe(false);
  });
});

describe('verbose-error suppression (SQL/ORM disclosure)', () => {
  it('withholds a response carrying a SQL/ORM error signature', async () => {
    // Withheld rather than masked: the signature opens the disclosure and the relation name, the
    // column and the offending value come after it, so masking the signature discloses the schema
    // anyway.
    const p = await createProtection({ mode: 'block' });
    const res: any = await p.screenResponse(json('{"error":"SequelizeDatabaseError: relation users does not exist"}', {}));
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(body).not.toContain('SequelizeDatabaseError');
    expect(body).not.toContain('relation users');
    expect(body).toContain('withheld by Patchstack');
  });

  it('leaves a benign error body unchanged', async () => {
    const p = await createProtection({ mode: 'block' });
    const res: any = await p.screenResponse(json('{"error":"Not found"}', {}));
    expect(await res.text()).toContain('Not found');
  });
});
