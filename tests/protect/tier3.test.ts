import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// Deep coverage for the Tier-3 protect-layer features (response redaction / egress SSRF /
// phases / options / invalid rules) — complements engine.test.ts (engine unit coverage)
// and runtime.test.ts (Supabase / server-fn integration).

const req = () => new Request('https://app.example.com/x');
const resp = (body: string, contentType = 'application/json', headers: Record<string, string> = {}) =>
  () => new Response(body, { status: 200, headers: { 'content-type': contentType, ...headers } });

async function bodyOf(r: any): Promise<string> {
  return typeof r?.text === 'function' ? await r.text() : '';
}

// --- shared egress harness: stub global fetch, run, always restore ---
async function withEgress(opts: any, fn: (p: any) => Promise<void>) {
  const orig = globalThis.fetch;
  const stub = (async (u: any) => ({ marker: 'stub', url: String(u) })) as any;
  globalThis.fetch = stub;
  const p = await createProtection({ egress: true, ...opts });
  try {
    await fn(p);
  } finally {
    p.uninstallEgress?.();
    globalThis.fetch = orig;
  }
  return stub;
}

describe('response phase — redaction depth', () => {
  it('redacts every default secret type, still serving the page', async () => {
    const p = await createProtection({ mode: 'block' });
    const cases: Array<[string, string]> = [
      ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIabc'],
      ['aws', 'key=AKIAIOSFODNN7EXAMPLE'],
      ['gcp', 'k=AIzaSyD1234567890abcdefghij1234567890xy'],
      ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
      ['db', 'mongodb://user:secret@db.host:27017/app'],
      ['stack', 'oops\n    at handler (/srv/app/index.js:42:13)'],
    ];
    for (const [label, secret] of cases) {
      const r: any = await p.fetch(resp(`{"x":"${secret}"}`, 'text/plain'))(req());
      const body = await bodyOf(r);
      expect(r.status, label).toBe(200);
      expect(body.includes('[REDACTED]'), `${label} masked`).toBe(true);
    }
  });

  it('masks MULTIPLE leaked spans in one body', async () => {
    const p = await createProtection({ mode: 'block' });
    const r: any = await p.fetch(resp('a AKIAIOSFODNN7EXAMPLE b AKIAXXXXXXXXXXXXXXXX c', 'text/plain'))(req());
    const body = await bodyOf(r);
    expect(body.includes('AKIA')).toBe(false);
    expect(body.match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  it('honors maskWith (string and per-category function)', async () => {
    const s: any = await createProtection({ mode: 'block', maskWith: '###' });
    expect(await bodyOf(await s.fetch(resp('AKIAIOSFODNN7EXAMPLE', 'text/plain'))(req()))).toContain('###');

    const f: any = await createProtection({ mode: 'block', maskWith: (c: string) => `<${c}>` });
    expect(await bodyOf(await f.fetch(resp('AKIAIOSFODNN7EXAMPLE', 'text/plain'))(req()))).toContain('<secret-exposure>');
  });

  it('redacts a contains-literal rule', async () => {
    const p = await createProtection({
      mode: 'block',
      responseRules: [{ phase: 'response', category: 'x', action: 'redact', rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'SEKRET' } }] }],
    });
    expect(await bodyOf(await p.fetch(resp('a SEKRET b', 'text/plain'))(req()))).toBe('a [REDACTED] b');
  });

  it('a redact rule with no maskable pattern falls back to withholding', async () => {
    const p = await createProtection({
      mode: 'block',
      responseRules: [{ phase: 'response', category: 'x', action: 'redact', rule_v2: [{ parameter: 'response.body', match: { type: 'isset' } }] }],
    });
    const r: any = await p.fetch(resp('anything', 'text/plain'))(req());
    expect(r.status).toBe(500);
  });

  it('screens response.header.* rules', async () => {
    const p = await createProtection({
      mode: 'block',
      responseRules: [{ phase: 'response', category: 'x', action: 'block', rule_v2: [{ parameter: 'response.header.x-secret', match: { type: 'isset' } }] }],
    });
    const r: any = await p.fetch(resp('ok', 'text/plain', { 'x-secret': '1' }))(req());
    expect(r.status).toBe(500);
  });
});

describe('response phase — gating & robustness', () => {
  it('does NOT scan non-text responses (content-type gate)', async () => {
    const p = await createProtection({ mode: 'block' });
    const r: any = await p.fetch(resp('AKIAIOSFODNN7EXAMPLE', 'image/png'))(req());
    expect(r.status).toBe(200);
    expect(await bodyOf(r)).toContain('AKIAIOSFODNN7EXAMPLE'); // untouched
  });

  it('does NOT scan oversized responses (content-length cap)', async () => {
    const p = await createProtection({ mode: 'block' });
    const r: any = await p.fetch(resp('AKIAIOSFODNN7EXAMPLE', 'text/plain', { 'content-length': '600000' }))(req());
    expect(await bodyOf(r)).toContain('AKIAIOSFODNN7EXAMPLE'); // skipped, untouched
  });

  it('a malformed response rule (no rule_v2 array) is skipped, response served', async () => {
    const p = await createProtection({ mode: 'block', responseRules: [{ id: 'bad', phase: 'response', rule_v2: null } as any] });
    const r: any = await p.fetch(resp('AKIAIOSFODNN7EXAMPLE', 'text/plain'))(req());
    expect(r.status).toBe(200);
    expect(await bodyOf(r)).toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('an invalid regex in a response rule never matches (no crash)', async () => {
    const p = await createProtection({
      mode: 'block',
      responseRules: [{ phase: 'response', action: 'redact', category: 'x', rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '(unclosed' } }] }],
    });
    const r: any = await p.fetch(resp('hello (unclosed world', 'text/plain'))(req());
    expect(r.status).toBe(200);
    expect(await bodyOf(r)).toContain('(unclosed');
  });
});

describe('egress phase — depth', () => {
  it('blocks every internal range via the guard, allows external', async () => {
    await withEgress({ mode: 'block' }, async () => {
      for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.9', 'localhost', '[::1]', 'metadata.google.internal']) {
        await expect(globalThis.fetch(`http://${host}/`), host).rejects.toThrow();
      }
      expect((await (globalThis.fetch as any)('https://8.8.8.8/')).marker).toBe('stub');
      expect((await (globalThis.fetch as any)('https://api.example.com/')).marker).toBe('stub');
    });
  });

  it('allowHosts exempts a host', async () => {
    await withEgress({ mode: 'block', allowHosts: ['169.254.169.254'] }, async () => {
      expect((await (globalThis.fetch as any)('http://169.254.169.254/latest/')).marker).toBe('stub');
    });
  });

  it('onEgressBlock receives url/host/method', async () => {
    const seen: any[] = [];
    await withEgress({ mode: 'block', onEgressBlock: (i: any) => seen.push(i) }, async () => {
      await expect(globalThis.fetch('http://127.0.0.1:9000/admin')).rejects.toThrow();
    });
    expect(seen[0]?.host).toBe('127.0.0.1');
    expect(seen[0]?.url).toContain('127.0.0.1');
  });

  it('uninstallEgress restores the original fetch', async () => {
    const orig = globalThis.fetch;
    const stub = (async () => ({ marker: 'stub' })) as any;
    globalThis.fetch = stub;
    const p = await createProtection({ egress: true, mode: 'block' });
    expect(globalThis.fetch).not.toBe(stub); // wrapped
    p.uninstallEgress?.();
    expect(globalThis.fetch).toBe(stub); // restored
    globalThis.fetch = orig;
  });
});

describe('createProtection — options & phase isolation', () => {
  it('defaults to dry-run', async () => {
    expect((await createProtection({})).mode).toBe('dry-run');
  });

  it('responseRules REPLACES the defaults (AWS default no longer active)', async () => {
    const p = await createProtection({
      mode: 'block',
      responseRules: [{ phase: 'response', category: 'x', action: 'redact', rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'FOO' } }] }],
    });
    const body = await bodyOf(await p.fetch(resp('AKIAIOSFODNN7EXAMPLE and FOO', 'text/plain'))(req()));
    expect(body).toContain('AKIAIOSFODNN7EXAMPLE'); // default rule replaced → not masked
    expect(body).toContain('[REDACTED]'); // FOO masked
  });

  it('splits rules by phase — a phase:response rule screens responses, NOT requests', async () => {
    const p = await createProtection({
      mode: 'block',
      rules: { firewall: [{ id: 'r', phase: 'response', action: 'block', category: 'x', rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'LEAK' } }] }], whitelists: [], whitelist_keys: {} },
    });
    // request carrying "LEAK" is NOT blocked (rule is response-phase → request engine empty)
    const reqWithLeak = new Request('https://app/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q":"LEAK"}' });
    expect(await p.fetchGuard()(reqWithLeak)).toBeNull();
    // but a response containing "LEAK" IS withheld
    const r: any = await p.fetch(resp('LEAK', 'text/plain'))(req());
    expect(r.status).toBe(500);
  });
});
