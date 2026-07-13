import { describe, expect, it } from 'vitest';
// The vendored runtime (node-waf engine + createProtection + Supabase guard),
// exported as @patchstack/connect/protect.
import { createProtection, createSupabaseGuard } from '../src/protect/runtime.js';

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
