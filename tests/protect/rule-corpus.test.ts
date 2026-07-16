import { describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// End-to-end rule coverage: canonical vpatch rules (one per vuln class), each run through the REAL
// request path (fetchGuard → fromFetchRequest → engine) rather than a hand-shaped engine object.
// Every case pairs an exploit (must block) with a benign request (must NOT — the false-positive
// guard), so the corpus doubles as a regression net against over-broad signatures.

const bundleOf = (rule_v2: unknown[]) => ({ firewall: [{ id: 'test-rule', category: 'test', rule_v2 }], whitelists: [], whitelist_keys: {} });
async function guardFor(rule_v2: unknown[], opts: Record<string, unknown> = {}) {
  const p: any = await createProtection({ rules: bundleOf(rule_v2), mode: 'block', ...opts });
  return p.fetchGuard();
}

const URL_BASE = 'https://app.test/x';
const get = (qs: string) => new Request(`${URL_BASE}?${qs}`);
const postJson = (obj: unknown) => new Request(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
const postRaw = (body: string) => new Request(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const postForm = (body: string) => new Request(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
const withHeaders = (h: Record<string, string>) => new Request(URL_BASE, { headers: h });

interface Case {
  name: string;
  rule_v2: unknown[];
  exploit: () => Request;
  benign: () => Request;
}

const cases: Case[] = [
  {
    name: 'prototype pollution (raw body contains __proto__)',
    rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '__proto__' } }],
    exploit: () => postRaw('{"__proto__":{"admin":true}}'),
    benign: () => postRaw('{"name":"alice"}'),
  },
  {
    name: 'path traversal (get.file regex)',
    rule_v2: [{ parameter: 'get.file', match: { type: 'regex', value: '/\\.\\.[\\/\\\\]/' } }],
    exploit: () => get('file=../../../etc/passwd'),
    benign: () => get('file=quarterly-report.pdf'),
  },
  {
    name: 'SQL injection (get.q regex)',
    rule_v2: [{ parameter: 'get.q', match: { type: 'regex', value: '/union\\s+select|\\bor\\b\\s+1=1/i' } }],
    exploit: () => get(`q=${encodeURIComponent('1 UNION SELECT password FROM users')}`),
    benign: () => get(`q=${encodeURIComponent('red running shoes size 10')}`),
  },
  {
    name: 'reflected XSS (post.comment inline_xss)',
    rule_v2: [{ parameter: 'post.comment', match: { type: 'inline_xss' } }],
    exploit: () => postJson({ comment: '<a href="x" onclick="steal()">click</a>' }),
    benign: () => postJson({ comment: 'she said "great post" — thanks!' }),
  },
  {
    name: 'command injection (post.host regex)',
    rule_v2: [{ parameter: 'post.host', match: { type: 'regex', value: '/[;&|`$()]/' } }],
    exploit: () => postJson({ host: 'example.com; rm -rf /' }),
    benign: () => postJson({ host: 'example.com' }),
  },
  {
    name: 'request-side SSRF (get.host internal_host)',
    rule_v2: [{ parameter: 'get.host', match: { type: 'internal_host' } }],
    exploit: () => get('host=169.254.169.254'),
    benign: () => get('host=api.stripe.com'),
  },
  {
    name: 'NoSQL injection (raw regex $-operators)',
    rule_v2: [{ parameter: 'raw', match: { type: 'regex', value: '/\\$(?:ne|gt|lt|where|regex)\\b/' } }],
    exploit: () => postRaw('{"user":{"$ne":null}}'),
    benign: () => postRaw('{"user":"bob"}'),
  },
  {
    name: 'scanner User-Agent (server.HTTP_USER_AGENT contains)',
    rule_v2: [{ parameter: 'server.HTTP_USER_AGENT', match: { type: 'contains', value: 'sqlmap' } }],
    exploit: () => withHeaders({ 'user-agent': 'sqlmap/1.7.2#stable' }),
    benign: () => withHeaders({ 'user-agent': 'Mozilla/5.0 (Macintosh)' }),
  },
  {
    name: 'malicious cookie (cookie.session regex)',
    rule_v2: [{ parameter: 'cookie.session', match: { type: 'regex', value: "/'|union|--/i" } }],
    exploit: () => withHeaders({ cookie: "session=' OR 1=1--" }),
    benign: () => withHeaders({ cookie: 'session=a1b2c3d4e5f6' }),
  },
  {
    name: 'base64-encoded payload (post.data mutation chain)',
    rule_v2: [{ parameter: 'post.data', mutations: ['base64_decode'], match: { type: 'contains', value: '<script' } }],
    exploit: () => postForm(`data=${encodeURIComponent(Buffer.from('<script>alert(1)</script>').toString('base64'))}`),
    benign: () => postForm(`data=${encodeURIComponent(Buffer.from('hello world').toString('base64'))}`),
  },
];

describe('rule corpus — exploit blocks, benign passes (per vuln class, end-to-end)', () => {
  for (const c of cases) {
    it(`${c.name}: exploit → 403`, async () => {
      const guard = await guardFor(c.rule_v2);
      const res = await guard(c.exploit());
      expect(res, 'exploit should be blocked').not.toBeNull();
      expect(res!.status).toBe(403);
    });

    it(`${c.name}: benign → allowed`, async () => {
      const guard = await guardFor(c.rule_v2);
      expect(await guard(c.benign()), 'benign request must not be blocked (false-positive guard)').toBeNull();
    });
  }
});

describe('rule corpus — engine semantics end-to-end', () => {
  const sqli = [{ parameter: 'get.q', match: { type: 'regex', value: '/union\\s+select/i' } }];

  it('dry-run mode detects but does not block', async () => {
    const onDetect = vi.fn();
    const p: any = await createProtection({ rules: bundleOf(sqli), mode: 'dry-run', onDetect });
    const res = await p.fetchGuard()(get(`q=${encodeURIComponent('1 UNION SELECT x')}`));
    expect(res).toBeNull(); // dry-run never blocks
    expect(onDetect).toHaveBeenCalled(); // …but it did detect
  });

  it('inclusive conditions are AND-ed (both must match)', async () => {
    const rule = [
      { parameter: 'get.a', match: { type: 'contains', value: 'x' }, inclusive: true },
      { parameter: 'get.b', match: { type: 'contains', value: 'y' }, inclusive: true },
    ];
    const guard = await guardFor(rule);
    expect(await guard(get('a=x&b=y')), 'both present → block').not.toBeNull();
    expect(await guard(get('a=x')), 'only one present → allow').toBeNull();
  });

  it('a whitelist suppresses a matching rule', async () => {
    const bundle = {
      firewall: [{ id: 'test-rule', category: 'test', rule_v2: sqli }],
      whitelists: [{ rule_id: 'test-rule', rule_v2: [{ parameter: 'get.bypass', match: { type: 'equals', value: 'yes' } }] }],
      whitelist_keys: {},
    };
    const p: any = await createProtection({ rules: bundle, mode: 'block' });
    const guard = p.fetchGuard();
    const q = encodeURIComponent('1 UNION SELECT x');
    expect(await guard(get(`q=${q}`)), 'no whitelist key → blocked').not.toBeNull();
    expect(await guard(get(`q=${q}&bypass=yes`)), 'whitelist key present → suppressed').toBeNull();
  });
});
