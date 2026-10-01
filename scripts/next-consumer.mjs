// Synthetic Next.js applications exercise the installed tarball, never a live account or rule service.
// Run: node scripts/next-consumer.mjs --next 14|15|16 [--bundler webpack|turbopack] [--tarball FILE]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = name => process.argv[process.argv.indexOf(name) + 1];
const versions = {
  14: { next: '14.2.35', react: '18.3.1', types: '18.3.31' },
  15: { next: '15.5.27', react: '19.3.0', types: '19.3.0' },
  16: { next: '16.3.8', react: '19.3.0', types: '19.3.0' },
};
const major = process.argv.includes('--next') ? value('--next') : '15';
assert.ok(Object.hasOwn(versions, major), '--next must be 14, 15 or 16');
const version = versions[major];
const bundler = process.argv.includes('--bundler') ? value('--bundler') : major === '16' ? 'turbopack' : 'webpack';
assert.ok(bundler === 'webpack' || (major === '16' && bundler === 'turbopack'), 'Turbopack coverage requires Next 16');
const scratch = mkdtempSync(path.join(tmpdir(), 'ps-next-consumer-'));
const app = path.join(scratch, 'app');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PATCHSTACK_')));
Object.assign(env, { NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' });
const read = file => readFileSync(path.join(app, file), 'utf8');
const put = (file, source) => {
  mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
  writeFileSync(path.join(app, file), source);
};
function run(command, args, cwd = app, includeStderr = false) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    // Fixture paths are ephemeral and are not part of the public test report.
    const output = `${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`.replaceAll(scratch, '<fixture>').replaceAll(root, '<repository>');
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed:\n${output}`.replaceAll(scratch, '<fixture>'));
  }
  return result.stdout + (includeStderr ? result.stderr : '');
}
let server;
let serverOutput = '';
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); server = undefined; }
}
async function serve(check) {
  serverOutput = '';
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', data => { serverOutput += data; });
  server.stderr.on('data', data => { serverOutput += data; });
  try {
    let base;
    for (let i = 0; i < 300; i++) {
      assert.equal(server.exitCode, null, 'Next server exited before readiness');
      const address = serverOutput.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (address) {
        base = address[0];
        try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* starting */ }
      }
      base = undefined;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(base, 'Next server did not become ready');
    await check(base);
  } finally { await stop(); }
}
function build() {
  console.log(`Building Next ${version.next} (${bundler})`);
  const output = run(process.execPath, ['node_modules/next/dist/bin/next', 'build', ...(major === '16' && bundler === 'webpack' ? ['--webpack'] : [])], app, true);
  assert.doesNotMatch(output, /Failed to compile/);
  for (const warning of output.split('\n\n')) {
    if (warning.includes('@patchstack/connect')) assert.doesNotMatch(warning, /not supported in the Edge Runtime/);
  }
}
const middleware = `import { NextResponse, type NextRequest } from 'next/server';
export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === '/tenant') return NextResponse.rewrite(new URL('/tenant-home', request.url));
  if (request.nextUrl.pathname.startsWith('/members') && !request.cookies.has('session')) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  const headers = new Headers(request.headers);
  headers.set('x-app-auth', 'preserved');
  const response = NextResponse.next({ request: { headers } });
  response.cookies.set('session', 'renewed', { httpOnly: true, sameSite: 'lax' });
  response.cookies.delete('expired');
  return response;
}
export const config = { matcher: ['/members/:path*', '/tenant', '/api/cookies'] };
`;
const rules = { firewall: [
  { id: 'synthetic-request', rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: 'synthetic-deny' } }] },
  { id: 'synthetic-response', phase: 'response', action: 'redact', rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/synthetic-private-value/' } }] },
], whitelists: [], whitelist_keys: {} };

async function probes(base, protectedApp) {
  const request = (url, init = {}) => fetch(base + url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal((await request('/')).status, 200);
  const redirect = await request('/members');
  assert.equal(redirect.status, 307);
  assert.equal(new URL(redirect.headers.get('location'), base).pathname, '/login');
  assert.equal((await request('/members', { headers: { cookie: 'session=valid' } })).status, 200);
  assert.match(await (await request('/tenant')).text(), /Tenant fixture/);
  const cookies = await request('/api/cookies');
  assert.deepEqual(await cookies.json(), { forwarded: 'preserved' });
  assert.equal(cookies.headers.getSetCookie().length, 2);
  assert.ok(cookies.headers.getSetCookie().some(cookie => /session=renewed;.*HttpOnly/i.test(cookie)));
  assert.ok(cookies.headers.getSetCookie().some(cookie => cookie.startsWith('expired=;')));
  const json = await request('/api/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello' }) });
  assert.equal(json.status, 201);
  assert.deepEqual(await json.json(), { message: 'hello' });
  const leak = await request('/api/contact');
  const leakBody = await leak.text();
  assert.equal(leakBody.includes('synthetic-private-value'), !protectedApp);
  assert.equal(leak.headers.get('x-handler'), 'contact');
  assert.equal(leak.headers.getSetCookie().length, 2);
  const raw = ' { "message": "café", "n": 1 }\r\n';
  const digest = createHash('sha256').update(raw).digest('hex');
  const webhook = await request('/api/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': digest }, body: raw });
  assert.equal(webhook.status, 200);
  assert.equal(await webhook.text(), raw);
  const form = new FormData();
  form.set('message', 'hello');
  form.set('file', new Blob([new Uint8Array([0, 255, 13, 10, 65])]), 'example.bin');
  const upload = await request('/api/upload', { method: 'POST', body: form });
  assert.equal(upload.status, 200);
  assert.deepEqual(await upload.json(), { message: 'hello', name: 'example.bin', bytes: [0, 255, 13, 10, 65] });
  const events = await request('/api/events');
  const reader = events.body.getReader();
  try {
    const chunk = await reader.read();
    assert.equal(new TextDecoder().decode(chunk.value), 'data: synthetic-private-value\n\n');
  } finally { await reader.cancel(); }
  const head = await request('/api/contact', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const options = await request('/api/contact', { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.match(options.headers.get('allow'), /POST/);
  assert.equal((await request('/api/error')).status, 500);
  const deny = await request('/api/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"synthetic-deny"}' });
  assert.equal(deny.status, protectedApp ? 403 : 201);
  // A page has no edited route handler: this assertion isolates the middleware guard.
  if (protectedApp) assert.equal((await request('/', { method: 'POST', body: 'synthetic-deny' })).status, 403);
  console.log(`PASS Next ${version.next}: ${protectedApp ? 'protected' : 'baseline'} auth, rewrites, cookies, JSON, signed bytes, uploads, SSE, methods and errors`);
}

try {
  mkdirSync(app);
  const tarball = process.argv.includes('--tarball') ? path.resolve(value('--tarball')) : (() => {
    run('npm', ['run', 'build'], root);
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root));
    return path.join(scratch, packed[0].filename);
  })();
  put('package.json', JSON.stringify({ private: true, type: 'module', dependencies: {
    '@patchstack/connect': `file:${tarball}`, next: version.next, react: version.react, 'react-dom': version.react,
  }, devDependencies: { typescript: '5.9.3', '@types/react': version.types, '@types/node': '22.18.6' } }));
  // Single build worker keeps the fixture inexpensive in shared CI runners.
  put('next.config.mjs', 'export default { experimental: { cpus: 1 } };');
  put('src/middleware.ts', middleware);
  put('src/app/layout.tsx', `export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }`);
  put('src/app/page.tsx', `export default function Page() { return <main>Public fixture</main>; }`);
  put('src/app/members/page.tsx', `export default function Page() { return <main>Members fixture</main>; }`);
  put('src/app/tenant-home/page.tsx', `export default function Page() { return <main>Tenant fixture</main>; }`);
  put('src/app/api/contact/route.ts', `export const dynamic = 'force-dynamic';
    export async function POST(request: Request) { return Response.json(await request.json(), { status: 201 }); }
    export async function GET() { return new Response('synthetic-private-value', { headers: [['content-type', 'text/plain'], ['x-handler', 'contact'], ['set-cookie', 'first=1; HttpOnly'], ['set-cookie', 'second=2; Secure']] }); }`);
  put('src/app/api/webhook/route.ts', `import { createHash } from 'node:crypto';
    export async function POST(request: Request) {
      const bytes = Buffer.from(await request.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== request.headers.get('x-signature')) return new Response('bad signature', { status: 400 });
      return new Response(bytes, { headers: { 'content-type': 'text/plain' } });
    }`);
  put('src/app/api/upload/route.ts', `export async function POST(request: Request) {
    const form = await request.formData(); const file = form.get('file') as File;
    return Response.json({ message: form.get('message'), name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) });
  }`);
  put('src/app/api/cookies/route.ts', `export async function GET(request: Request) { return Response.json({ forwarded: request.headers.get('x-app-auth') }); }`);
  put('src/app/api/events/route.ts', `export const dynamic = 'force-dynamic';
    export async function GET(request: Request) {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: synthetic-private-value\\n\\n'));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }`);
  put('src/app/api/error/route.ts', `export const dynamic = 'force-dynamic';
    export async function GET() { throw new Error('synthetic application failure'); return new Response('unreachable'); }`);
  console.log(`Installing synthetic fixture: Next ${version.next}, React ${version.react}`);
  run('npm', ['install', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(JSON.parse(read('node_modules/next/package.json')).version, version.next);
  const cli = ['node_modules/@patchstack/connect/dist/cli.js'];
  build();
  await serve(base => probes(base, false));
  run(process.execPath, [...cli, 'protect']);
  put('src/patchstack.rules.json', JSON.stringify(rules));
  const composed = read('src/middleware.ts');
  const contact = read('src/app/api/contact/route.ts');
  assert.match(composed, /patchstack-next-composed/);
  assert.match(contact, /screenPatchstackResponse/);
  run(process.execPath, [...cli, 'protect']);
  assert.equal(read('src/middleware.ts'), composed);
  assert.equal(read('src/app/api/contact/route.ts'), contact);
  assert.match(run(process.execPath, [...cli, 'protect', '--check']), /guard is wired/);
  build();
  await serve(base => probes(base, true));

  if (major === '16') {
    // A real proxy build proves refusal does not leave a conflicting middleware behind.
    rmSync(path.join(app, 'src/middleware.ts'));
    const proxy = middleware.replace('function middleware(', 'function proxy(');
    put('src/proxy.ts', proxy);
    assert.match(run(process.execPath, [...cli, 'protect']), /proxy integration requires manual wiring/);
    assert.equal(read('src/proxy.ts'), proxy);
    assert.equal(existsSync(path.join(app, 'src/middleware.ts')), false);
    assert.throws(() => run(process.execPath, [...cli, 'protect', '--check']), /proxy wiring requires manual verification/);
    build();
    await serve(async base => {
      assert.equal((await fetch(base + '/members', { redirect: 'manual' })).status, 307);
      assert.match(await (await fetch(base + '/tenant')).text(), /Tenant fixture/);
      // The unchanged proxy does not claim protection; already-composed routes still enforce rules.
      assert.equal((await fetch(base + '/api/contact', { method: 'POST', body: 'synthetic-deny' })).status, 403);
    });
    console.log('PASS Next proxy: unchanged routing, no competing middleware, explicit manual-integration gap');
  }
} catch (error) {
  console.error(String(error.stack ?? error).replaceAll(scratch, '<fixture>').replaceAll(root, '<repository>'));
  if (serverOutput) console.error(serverOutput.replaceAll(scratch, '<fixture>').replaceAll(root, '<repository>'));
  process.exitCode = 1;
} finally {
  await stop();
  rmSync(scratch, { recursive: true, force: true });
}
