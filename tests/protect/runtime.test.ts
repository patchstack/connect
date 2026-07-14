import { describe, expect, it } from 'vitest';
// The vendored runtime (node-waf engine + createProtection + Supabase guard),
// exported as @patchstack/connect/protect.
import { createProtection, createSupabaseGuard, createServerFnGuard } from '../../src/protect/runtime.js';

const rules = {
  firewall: [
    {
      id: 'rm-npm-0001',
      title: 'Block stored XSS via vulnerable markdown renderer (marked)',
      rule_v2: [{ parameter: 'post.title', mutations: ['urldecode'], match: { type: 'inline_xss' } }],
    },
  ],
  whitelists: [],
  whitelist_keys: {},
};

const SUPABASE = 'https://proj.supabase.co';
const TASKS = `${SUPABASE}/rest/v1/tasks`;
const okFetch = async () =>
  new Response('[{"id":"1"}]', { status: 201, headers: { 'content-type': 'application/json' } });

function insertReq(title: string, headers: Record<string, string> = {}) {
  return new Request('https://app.example.com/_patchstack/guard', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ps-target': TASKS, ...headers },
    body: JSON.stringify({ title }),
  });
}

describe('@patchstack/connect/protect (vendored engine + supabase guard)', () => {
  it('block mode: exploit → 403, benign → forwarded 201', async () => {
    const protection = await createProtection({ rules, mode: 'block' });
    const handle = createSupabaseGuard({ protection, supabaseUrl: SUPABASE, fetchImpl: okFetch });
    expect((await handle(insertReq('<img src=x onerror="steal()">'))).status).toBe(403);
    expect((await handle(insertReq('buy milk'))).status).toBe(201);
  });

  it('SSRF: disallowed target → 403, never forwarded', async () => {
    let forwarded = false;
    const protection = await createProtection({ rules, mode: 'block' });
    const handle = createSupabaseGuard({
      protection,
      supabaseUrl: SUPABASE,
      fetchImpl: async () => {
        forwarded = true;
        return new Response('x');
      },
    });
    const res = await handle(insertReq('buy milk', { 'x-ps-target': 'http://169.254.169.254/latest/meta-data/' }));
    expect(res.status).toBe(403);
    expect(forwarded).toBe(false);
  });

  it('dry-run: exploit is NOT blocked (forwarded), detection recorded', async () => {
    const detections: unknown[] = [];
    const protection = await createProtection({ rules, mode: 'dry-run', onDetect: (d: unknown) => detections.push(d) });
    const handle = createSupabaseGuard({ protection, supabaseUrl: SUPABASE, fetchImpl: okFetch });
    const res = await handle(insertReq('<img src=x onerror="steal()">'));
    expect(res.status).toBe(201);
    expect(detections.length).toBe(1);
  });
});

describe('createServerFnGuard (TanStack server-function path)', () => {
  it('block mode: exploit args → receipt, benign args → null', async () => {
    const protection = await createProtection({ rules, mode: 'block' });
    const guard = createServerFnGuard({ protection });
    const blocked = await guard({ title: '<img src=x onerror="steal()">' });
    expect(blocked?.rule).toBe('rm-npm-0001');
    expect(await guard({ title: 'buy milk' })).toBeNull();
  });

  it('dry-run: exploit args → null (not blocked), detection recorded', async () => {
    const detections: unknown[] = [];
    const protection = await createProtection({
      rules,
      mode: 'dry-run',
      onDetect: (d: unknown) => detections.push(d),
    });
    const guard = createServerFnGuard({ protection });
    expect(await guard({ title: '<img src=x onerror="steal()">' })).toBeNull();
    expect(detections.length).toBe(1);
  });
});

const jsonReq = (body: unknown) =>
  new Request('https://app.example.com/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('array parameters (rule_v2 ["post.a","post.b"])', () => {
  it('matches when ANY listed source has the payload', async () => {
    const arrRules = {
      firewall: [{ id: 'arr', rule_v2: [{ parameter: ['post.a', 'post.b'], match: { type: 'contains', value: 'evil' } }] }],
      whitelists: [],
      whitelist_keys: {},
    };
    const g = (await createProtection({ rules: arrRules, mode: 'block' })).fetchGuard();
    expect((await g(jsonReq({ a: 'evil' })))?.status).toBe(403);
    expect((await g(jsonReq({ b: 'evil' })))?.status).toBe(403);
    expect(await g(jsonReq({ a: 'ok' }))).toBeNull();
  });
});

describe('response phase — leak detection', () => {
  const leak = () => new Response(JSON.stringify({ ok: true, awsKey: 'AKIAIOSFODNN7EXAMPLE' }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('default rules REDACT the leaked span and still serve the page', async () => {
    const detections: any[] = [];
    const p = await createProtection({ mode: 'block', onDetect: (d: any) => detections.push(d) });
    const res: any = await p.fetch(leak)(jsonReq({}));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.includes('AKIAIOSFODNN7EXAMPLE')).toBe(false);
    expect(body.includes('[REDACTED]')).toBe(true);
    expect(detections.some((d) => d.phase === 'response' && d.category === 'secret-exposure')).toBe(true);
  });

  it('action:block rule withholds the whole response', async () => {
    const p = await createProtection({
      mode: 'block',
      responseRules: [{ id: 'r-block', phase: 'response', action: 'block', category: 'secret-exposure', rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'TOPSECRET' } }] }],
    });
    const res: any = await p.fetch(() => new Response('x TOPSECRET y', { headers: { 'content-type': 'text/plain' } }))(jsonReq({}));
    expect(res.status).toBe(500);
  });

  it('dry-run serves the ORIGINAL (unmasked) response', async () => {
    const p = await createProtection({ mode: 'dry-run' });
    const res: any = await p.fetch(leak)(jsonReq({}));
    expect((await res.text()).includes('AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });
});

describe('egress phase — SSRF', () => {
  it('block mode: internal host blocked, external allowed', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: any) => ({ marker: 'stub', url: String(u) })) as any;
    const p = await createProtection({ egress: true, mode: 'block' });
    try {
      await expect(globalThis.fetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
      expect((await (globalThis.fetch as any)('https://api.example.com/')).marker).toBe('stub');
    } finally {
      p.uninstallEgress?.();
      globalThis.fetch = orig;
    }
  });

  it('dry-run: detected but allowed', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({ marker: 'stub' })) as any;
    const detections: any[] = [];
    const p = await createProtection({ egress: true, mode: 'dry-run', onDetect: (d: any) => detections.push(d) });
    try {
      expect((await (globalThis.fetch as any)('http://127.0.0.1:9000/')).marker).toBe('stub');
    } finally {
      p.uninstallEgress?.();
      globalThis.fetch = orig;
    }
    expect(detections.some((d) => d.phase === 'egress')).toBe(true);
  });
});
