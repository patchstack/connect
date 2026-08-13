import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProtection } from '../../src/protect/runtime.js';
import { installEgressGuard } from '../../src/protect/egress.js';
import { fromNodeRequest } from '../../src/protect/engine/node.js';
import { _testExports } from '../../src/protect/engine/engine.js';
import { runProtect, runVerify } from '../../src/protect/install/index.js';

afterEach(() => vi.restoreAllMocks());
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));
const streamOf = (s: string) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } });

describe('item 7 — Nuxt adapter', () => {
  it('scaffolds server/middleware/patchstack.ts + co-located rules', () => {
    const dir = tmp('ps-nuxt-');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { nuxt: '^3.0.0' } }));
    try {
      const res: any = runProtect(dir);
      expect(res.adapter).toBe('nuxt');
      const mw = readFileSync(path.join(dir, 'server/middleware/patchstack.ts'), 'utf8');
      expect(mw).toContain('patchstack-nuxt');
      expect(mw).toContain('defineEventHandler');
      expect(existsSync(path.join(dir, 'server/middleware/patchstack.rules.json'))).toBe(true);
      expect(runVerify(dir).wired).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('item 1 — fetch DNS pre-resolve screen', () => {
  async function withGuard(lookup: any, shouldBlock: any, allowHosts?: string[]) {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok')) as any; // stub the real network
    const restore = await installEgressGuard({ shouldBlock, lookup, allowHosts });
    return () => { restore(); globalThis.fetch = orig; };
  }

  it('blocks a hostname that resolves to an internal address', async () => {
    const done = await withGuard((_h: string, _o: any, cb: any) => cb(null, [{ address: '169.254.169.254', family: 4 }]), (_u: string, h: string) => /^169\.254\./.test(String(h)));
    try {
      let blocked = false;
      try {
        await globalThis.fetch('http://rebind.test/');
      } catch (e) {
        blocked = /Patchstack blocked/.test(String(e));
      }
      expect(blocked).toBe(true);
    } finally {
      done();
    }
  });

  it('allows a hostname that resolves to a public address', async () => {
    const done = await withGuard((_h: string, _o: any, cb: any) => cb(null, [{ address: '93.184.216.34', family: 4 }]), (_u: string, h: string) => /^169\.254\./.test(String(h)));
    try {
      expect(await (await globalThis.fetch('http://public.test/')).text()).toBe('ok');
    } finally {
      done();
    }
  });
});

describe('item 2 — response streaming cap (no Content-Length)', () => {
  const redactRule = { phase: 'response', category: 'x', action: 'redact', rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'SECRET' } }] };
  const empty = { firewall: [], whitelists: [], whitelist_keys: {} };

  it('passes an over-cap streamed body through unscreened; screens an under-cap one', async () => {
    const p: any = await createProtection({ rules: empty, responseRules: [redactRule], mode: 'block' });
    const big = 'SECRET' + 'a'.repeat(600 * 1024);
    const over = await p.screenResponse(new Response(streamOf(big), { status: 200, headers: { 'content-type': 'text/plain' } }));
    expect((await over.text()).startsWith('SECRET')).toBe(true); // over cap → not screened

    const under = await p.screenResponse(new Response('SECRET here', { status: 200, headers: { 'content-type': 'text/plain' } }));
    expect(await under.text()).not.toContain('SECRET'); // under cap → redacted
  });
});

describe('item 3 — multipart on the node adapter + comparator coercion', () => {
  it('parses multipart fields + file metadata via fromNodeRequest', () => {
    const b = 'X';
    const body =
      `--${b}\r\nContent-Disposition: form-data; name="comment"\r\n\r\n<script>alert(1)</script>\r\n` +
      `--${b}\r\nContent-Disposition: form-data; name="avatar"; filename="x.png"\r\n\r\nBINARY\r\n--${b}--\r\n`;
    const shaped: any = fromNodeRequest({ method: 'POST', url: '/x', headers: { 'content-type': `multipart/form-data; boundary=${b}` } } as any, body);
    expect(shaped.body.comment).toBe('<script>alert(1)</script>');
    // File parts are captured as { filename, type, content } for content inspection.
    expect(shaped.files.avatar).toMatchObject({ filename: 'x.png', content: 'BINARY' });
  });

  it('in_array / array_in_array coerce numeric rule values to match string request values', () => {
    const { matchValue } = _testExports as any;
    expect(matchValue('in_array', '2', [1, 2, 3])).toBe(true);
    expect(matchValue('array_in_array', ['2'], [1, 2, 3])).toBe(true);
    expect(matchValue('equals_strict', '1', 1)).toBe(false); // still type-strict
  });
});

describe('item 5 — lossless big-int on structural masking', () => {
  const maskRule = (key: string) => ({ phase: 'response', category: 'pii', action: 'redact', rule_v2: [{ parameter: 'response.body', mutations: ['json_decode'], match: { type: 'array_key_value', key, match: { type: 'isset' } } }] });

  it('preserves an out-of-safe-range integer elsewhere in the body', async () => {
    const p: any = await createProtection({ rules: { firewall: [], whitelists: [], whitelist_keys: {} }, responseRules: [maskRule('user.email')], mode: 'block' });
    const doc = '{"user":{"email":"a@x.com"},"id":12345678901234567890}';
    const text = await (await p.screenResponse(new Response(doc, { status: 200, headers: { 'content-type': 'application/json' } }))).text();
    expect(text).toContain('"email":"[REDACTED]"'); // targeted field masked
    expect(text).toContain('12345678901234567890'); // big int preserved verbatim, not rounded
  });
});
