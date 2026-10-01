import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { runProtect, runVerify } from '../../src/protect/install/index.js';
import { composeNextMiddleware, composeNextRoute, nextSourceWired, standardNextRouting } from '../../src/protect/install/adapters/next-source.js';
import { extractInputMap } from '../../src/map/extract.js';

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ps-next-compose-'));
  dirs.push(dir);
  put(dir, 'package.json', JSON.stringify({ type: 'module', dependencies: { next: '^15.0.0' } }));
  return dir;
}
function put(dir: string, file: string, source: string) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), source);
}
const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
afterEach(() => {
  dirs.splice(0).forEach(dir => rmSync(dir, { force: true, recursive: true }));
  vi.restoreAllMocks();
});

async function load(source: string, stub: string) {
  const dir = fixture();
  put(dir, 'guard.mjs', stub);
  put(dir, 'subject.mjs', transformSync(source, { loader: 'ts', format: 'esm' }).code);
  return import(pathToFileURL(join(dir, 'subject.mjs')).href);
}

const GUARD_STUB = `
export async function getPatchstackProtection() {
  return {
    fetchGuard: () => async request => request.headers.has('x-test-deny') ? new Response('blocked', { status: 403 }) : null,
    screenResponse: async (response, request) => new Response((await response.text()).replace('private-value', '[redacted]'), { status: response.status, headers: { 'x-screened-route': new URL(request.url).pathname } })
  };
}
export async function screenPatchstackResponse(response, request, protection) {
  return protection ? protection.screenResponse(await response, request) : response;
}
`;

describe('Next middleware composition', () => {
  const source = `
export function middleware(request: Request, event: { waitUntil: (p: Promise<unknown>) => void }) {
  event.waitUntil(Promise.resolve());
  return Response.redirect(new URL('/sign-in', request.url));
}
export const config = { matcher: ['/members/:path*', '/account'] };
`;

  it('screens globally while preserving the original redirect scope and event', async () => {
    const composed = composeNextMiddleware(ts, 'middleware.ts', source, './guard.mjs')!;
    expect(composed).not.toBeNull();
    const api = await load(composed, GUARD_STUB);
    const event = { waitUntil: vi.fn() };
    expect(api.config.matcher).toBe('/:path*');
    for (const path of ['/members', '/members/profile', '/account', '/account.json', '/account/']) {
      expect((await api.middleware(new Request(`https://app.example${path}`), event)).status).toBe(302);
    }
    expect(event.waitUntil).toHaveBeenCalledTimes(5);
    for (const path of ['/api/contact', '/memberships', '/account/settings']) {
      expect(await api.middleware(new Request(`https://app.example${path}`), event)).toBeUndefined();
    }
    expect(event.waitUntil).toHaveBeenCalledTimes(5);
    expect((await api.middleware(new Request('https://app.example/api/contact', { headers: { 'x-test-deny': '1' } }), event)).status).toBe(403);
    expect(event.waitUntil).toHaveBeenCalledTimes(5);
  });

  it('persists a shared helper, keeps user code, bakes only public identity, and is idempotent', () => {
    const dir = fixture();
    put(dir, 'src/middleware.ts', source);
    put(dir, '.patchstackrc.json', JSON.stringify({ siteUuid: '22222222-2222-4222-8222-222222222222' }));
    put(dir, '.patchstackrc.local.json', JSON.stringify({ apiKey: 'synthetic-private-credential' }));
    runProtect(dir);
    const modified = read(dir, 'src/middleware.ts');
    expect(modified).toContain("return Response.redirect(new URL('/sign-in', request.url))");
    expect(read(dir, 'src/patchstack.next.ts')).toContain('22222222-2222-4222-8222-222222222222');
    expect(read(dir, 'src/patchstack.next.ts')).not.toContain('synthetic-private-credential');
    expect(runVerify(dir).wired).toBe(true);
    expect(runVerify(dir).checks.some(c => c.label.includes('PATCHSTACK_API_KEY') && c.unverifiable)).toBe(true);
    runProtect(dir);
    expect(read(dir, 'src/middleware.ts')).toBe(modified);
  });

  it.each([
    `export { middleware } from './auth';`,
    `export const middleware = makeMiddleware();`,
    `export function middleware(request: Request) {}\nexport const config = { matcher: [{ source: '/private', has: [{ type: 'header', key: 'x-a' }] }] };`,
    `export function middleware(request: Request) {}\nexport const config = { matcher: '/((?!api).*)' };`,
    `export function middleware(request: Request) {}\nexport const config = getConfig();`,
  ])('does not guess unsupported exports or matchers', source => {
    expect(composeNextMiddleware(ts, 'middleware.ts', source, './guard.mjs')).toBeNull();
  });

  it('does not widen middleware in a custom-routing app', () => {
    const dir = fixture();
    put(dir, 'middleware.ts', source);
    put(dir, 'next.config.mjs', `export default { basePath: '/application' };`);
    runProtect(dir);
    expect(read(dir, 'middleware.ts')).toBe(source);
    expect(runVerify(dir).wired).toBe(false);
  });

  it('only widens statically understood framework configuration', () => {
    expect(standardNextRouting(ts, 'next.config.ts', `import type { NextConfig } from 'next';
const config = { reactStrictMode: true, images: { domains: ['images.example'] } } satisfies NextConfig;
export default config;`)).toBe(true);
    for (const source of [
      `export default { ...routing };`,
      `import config from './routing'; export default config;`,
      `export default withPlugin({});`,
      `const config = {}; config.basePath = '/app'; export default config;`,
      `const config = {}; const sideEffect = mutate(config); export default config;`,
      `export default { i18n: { locales: ['en'], defaultLocale: 'en' } };`,
    ]) expect(standardNextRouting(ts, 'next.config.ts', source)).toBe(false);
  });

  it('does not overwrite an existing helper or attach middleware to an unrelated file', () => {
    const dir = fixture();
    put(dir, 'middleware.ts', source);
    put(dir, 'patchstack.next.ts', `export const unrelated = true;`);
    runProtect(dir);
    expect(read(dir, 'middleware.ts')).toBe(source);
    expect(read(dir, 'patchstack.next.ts')).toBe('export const unrelated = true;');
    expect(runVerify(dir).wired).toBe(false);
  });

  it('handles JavaScript without adding TypeScript syntax', () => {
    const dir = fixture();
    put(dir, 'middleware.js', `export const middleware = (request) => { return Response.redirect(new URL('/login', request.url)); };`);
    runProtect(dir);
    expect(read(dir, 'middleware.js')).toContain('async (request)');
    expect(read(dir, 'patchstack.next.js')).not.toContain('type Protection');
    expect(runVerify(dir).wired).toBe(true);
  });
});

describe('Next App Router composition', () => {
  const source = `
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await request.json();
  const params = await context.params;
  if (body.fail) throw new Error('application failed');
  return new Response(params.id + ':' + body.message, { status: 201 });
}
export async function GET() { return new Response('private-value'); }
`;

  it('preserves request bodies, context, status, exceptions and filters the final response', async () => {
    const composed = composeNextRoute(ts, 'route.ts', source, './guard.mjs')!;
    expect(composed).not.toBeNull();
    expect(nextSourceWired(ts, 'route.ts', composed, './guard.mjs', true)).toBe(true);
    const api = await load(composed, GUARD_STUB);
    const request = (value: unknown, headers = {}) => new Request('https://app.example/api/message', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
    const context = { params: Promise.resolve({ id: 'entry' }) };
    const response = await api.POST(request({ message: 'private-value' }), context);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('entry:[redacted]');
    expect(response.headers.get('x-screened-route')).toBe('/api/message');
    await expect(api.POST(request({ fail: true }), context)).rejects.toThrow('application failed');
    expect((await api.POST(request({ fail: true }, { 'x-test-deny': '1' }), context)).status).toBe(403);
    expect(await (await api.GET(new Request('https://app.example/api/message'))).text()).toBe('[redacted]');
  });

  it('does not swallow an application failure or repeat work when protection is unavailable', async () => {
    const composed = composeNextRoute(ts, 'route.ts', source, './guard.mjs')!;
    const api = await load(composed, GUARD_STUB.replace(/export async function getPatchstackProtection\(\) \{[\s\S]*?\n\}/, 'export async function getPatchstackProtection() { return null; }'));
    expect(await (await api.GET(new Request('https://app.example/api/message'))).text()).toBe('private-value');
    const request = new Request('https://app.example/api/message', { method: 'POST', body: '{"fail":true}' });
    await expect(api.POST(request, { params: Promise.resolve({ id: 'entry' }) })).rejects.toThrow('application failed');
  });

  it('wires routes, reports newly added and unsupported routes, and checks missing guard calls', () => {
    const dir = fixture();
    put(dir, 'src/app/api/message/route.ts', source);
    runProtect(dir);
    expect(runVerify(dir).wired).toBe(true);
    const generated = read(dir, 'src/app/api/message/route.ts');
    runProtect(dir);
    expect(read(dir, 'src/app/api/message/route.ts')).toBe(generated);
    put(dir, 'src/app/api/other/route.ts', 'export const POST = handler;');
    expect(runVerify(dir).wired).toBe(false);
    runProtect(dir);
    expect(read(dir, 'src/app/api/other/route.ts')).toBe('export const POST = handler;');
    expect(nextSourceWired(ts, 'route.ts', generated.replace('if (psBlocked) return psBlocked;', ''), '../../../patchstack.next', true)).toBe(false);
    expect(nextSourceWired(ts, 'route.ts', generated.replace('screenPatchstackResponse((', 'unprotectedResponse(('), '../../../patchstack.next', true)).toBe(false);
    expect(nextSourceWired(ts, 'route.ts', generated + '\nexport const PUT = externalHandler;', '../../../patchstack.next', true)).toBe(false);
  });

  it('reports JSX route files as a manual integration gap', () => {
    const dir = fixture();
    put(dir, 'app/api/view/route.tsx', `export async function GET() { return new Response('example'); }`);
    runProtect(dir);
    expect(runVerify(dir).wired).toBe(false);
    expect(runVerify(dir).checks.find(c => c.label.startsWith('App Router'))?.hint).toContain('app/api/view/route.tsx');
  });

  it('keeps module directives and does not screen nested helper returns', () => {
    const source = `'use strict';\nexport const GET = async (request: Request) => {
      function nested() { return 'ordinary'; }
      return new Response(nested());
    };`;
    const result = composeNextRoute(ts, 'route.ts', source, './guard.mjs')!;
    expect(result.startsWith("'use strict';")).toBe(true);
    expect(result).toContain("function nested() { return 'ordinary'; }");
    expect(nextSourceWired(ts, 'route.ts', result, './guard.mjs', true)).toBe(true);
  });

  it('preserves the proven input-to-sink flow for mapping', async () => {
    const dir = fixture();
    put(dir, 'app/api/run/route.ts', `import { exec } from 'node:child_process';
export async function POST(request: Request) {
  const body = await request.json();
  exec(body.command);
  return new Response('ok');
}`);
    const before = await extractInputMap(dir, ts);
    runProtect(dir);
    const after = await extractInputMap(dir, ts);
    const proven = (map: typeof before) => map.endpoints.flatMap(e => e.flows.filter(f => f.confidence === 'exact-local').map(f => ({ route: e.route, method: e.method, input: f.input, sink: f.sink.kind })));
    expect(proven(before).length).toBeGreaterThan(0);
    expect(proven(after)).toEqual(proven(before));
  });
});
