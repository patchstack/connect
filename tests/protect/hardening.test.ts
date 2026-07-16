import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProtection, createServerFnGuard } from '../../src/protect/runtime.js';
import { fromNodeRequest } from '../../src/protect/engine/node.js';
import { installEgressGuard } from '../../src/protect/engine/../egress.js';
import { _testExports } from '../../src/protect/engine/engine.js';
import { runProtect } from '../../src/protect/install/index.js';

// Robustness regression tests across the request/response guards, egress, rule loading and the installer.
afterEach(() => vi.restoreAllMocks());
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));

describe('request shaping is crash-proof on unusual input', () => {
  it('shaping never throws on unusual Host / url values', () => {
    for (const host of ['a b', '[::bad', '%', 'ok.com:99999999']) {
      expect(() => fromNodeRequest({ method: 'GET', url: '/x?q=1', headers: { host } }, '')).not.toThrow();
    }
  });

  it('node middleware fails open (calls next) on unusual input', async () => {
    const p: any = await createProtection({ rules: { firewall: [], whitelists: [], whitelist_keys: {} }, mode: 'block' });
    const nextCalled = await new Promise((resolve) => {
      const req: any = { method: 'GET', url: '/', headers: { host: 'a b' }, on(ev: string, fn: any) { if (ev === 'end') queueMicrotask(fn); return this; } };
      p.node()(req, {}, () => resolve(true));
    });
    expect(nextCalled).toBe(true);
  });
});

describe('rule loading validates the API response', () => {
  const RULES = { firewall: [{ id: 'rm-npm-0001', rule_v2: [{ parameter: 'post.title', match: { type: 'inline_xss' } }] }], whitelists: [], whitelist_keys: {} };
  const XSS = { title: '<img src=x onerror="steal()">' };

  it('ignores a non-rule API response and keeps the last-known-good cache', async () => {
    const cacheDir = tmp('ps-hard-cache-');
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(RULES), { status: 200 })));
      await createProtection({ siteUuid: 's', pulseRulesUrl: 'https://x.test/p', cacheDir, mode: 'block' });
      const cached = readFileSync(path.join(cacheDir, 'patchstack-rules.json'), 'utf8');

      // A valid-JSON 200 that isn't a rule envelope.
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 200 })));
      const p: any = await createProtection({ siteUuid: 's', pulseRulesUrl: 'https://x.test/p', cacheDir, mode: 'block' });
      expect((await createServerFnGuard({ protection: p })(XSS))?.rule).toBe('rm-npm-0001'); // still using the cached rules
      expect(readFileSync(path.join(cacheDir, 'patchstack-rules.json'), 'utf8')).toBe(cached); // cache unchanged
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('redaction regexes are guarded like detection', () => {
  it('a guarded-out regex is skipped and returns promptly', async () => {
    const rule = { id: 'r', phase: 'response', category: 'x', action: 'redact', rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/(\\w+)+$/' } }] };
    const p: any = await createProtection({ rules: { firewall: [], whitelists: [], whitelist_keys: {} }, responseRules: [rule], mode: 'block' });
    const body = 'a'.repeat(60) + '!';
    const started = process.hrtime.bigint();
    const out = await p.screenResponse(new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(1000);
    expect(await out.text()).toBe(body); // guarded-out redactor skipped → body unchanged
  });
});

describe('internal-host check covers IPv4-mapped IPv6', () => {
  it('flags IPv4-mapped IPv6 loopback / link-local forms', () => {
    const { isInternalHost } = _testExports as any;
    expect(isInternalHost('::ffff:7f00:1')).toBe(true);
    expect(isInternalHost('::ffff:a9fe:a9fe')).toBe(true);
    expect(isInternalHost('::ffff:0808:0808')).toBe(false); // a public address stays allowed
  });
});

describe('egress screen: host defaulting + allowlist', () => {
  it('defaults an omitted host so it is still screened', async () => {
    const restore = await installEgressGuard({ shouldBlock: (_u, h) => h === 'localhost' || /^127\./.test(String(h)) });
    try {
      const http: any = (await import('node:http')).default;
      let threw = false;
      try {
        http.request({ port: 8080, path: '/x' });
      } catch (e) {
        threw = /Patchstack blocked/.test(String(e));
      }
      expect(threw).toBe(true);
    } finally {
      restore();
    }
  });

  it('does not screen a hostname that is explicitly allowlisted', async () => {
    let looked = false;
    const restore = await installEgressGuard({
      shouldBlock: (_u, h) => /^10\./.test(String(h)),
      allowHosts: ['internal-api.test'],
      lookup: (_h: string, _o: any, cb: any) => { looked = true; cb(null, [{ address: '10.0.0.5', family: 4 }]); },
    });
    try {
      const http: any = (await import('node:http')).default;
      const req = http.request('http://internal-api.test/');
      req.on('error', () => {});
      req.destroy();
      expect(looked).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('CommonJS installs get a runnable guard matching the module format', () => {
  for (const [stack, dep, ctor, importName] of [
    ['fastify', 'fastify', 'fastify()', 'patchstackFastify'],
    ['nestjs', '@nestjs/core', 'await NestFactory.create(AppModule)', 'patchstackMiddleware'],
  ] as const) {
    it(`${stack}: a CommonJS entry gets guard.cjs + require`, () => {
      const dir = tmp(`ps-${stack}-cjs-`);
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', main: 'server.js', dependencies: { [dep]: '^1' } }));
      const src =
        stack === 'nestjs'
          ? `const { NestFactory } = require('@nestjs/core');\nasync function main(){ const app = ${ctor}; app.use(express.json()); await app.listen(3000); }\nmain();\n`
          : `const Fastify = require('fastify');\nconst app = ${ctor};\napp.listen({ port: 3000 });\n`;
      writeFileSync(path.join(dir, 'server.js'), src);
      try {
        runProtect(dir);
        const server = readFileSync(path.join(dir, 'server.js'), 'utf8');
        expect(existsSync(path.join(dir, 'patchstack/guard.cjs'))).toBe(true);
        expect(existsSync(path.join(dir, 'patchstack/guard.ts'))).toBe(false);
        expect(server).toContain(`const { ${importName} } = require("./patchstack/guard.cjs");`);
        expect(server).not.toContain('import {');
        execFileSync(process.execPath, ['--check', path.join(dir, 'server.js')]);
        execFileSync(process.execPath, ['--check', path.join(dir, 'patchstack/guard.cjs')]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
