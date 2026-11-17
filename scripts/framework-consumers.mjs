import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVATION_HEADER, activationChallenge, verifyActivationResponse } from '../src/protect/activation.js';

const output = `({ label: body.label, sample: 'fixture-private' })`;
const fetchRoute = `async ({ request }) => {
  const body = await request.json();
  return Response.json(${output});
}`;
const fixtures = {
  astro: {
    dependencies: { astro: '7.4.12', '@astrojs/node': '11.1.13' },
    files: {
      'astro.config.mjs': `import node from '@astrojs/node';
export default { output: 'server', adapter: node({ mode: 'standalone' }) };`,
      'src/pages/fixture.js': `export const POST = ${fetchRoute};`,
    },
    rules: 'src/patchstack.rules.json',
    build: ['node_modules/.bin/astro', 'build'],
    start: ['dist/server/entry.mjs'],
  },
  sveltekit: {
    dependencies: { '@sveltejs/kit': '3.3.0', '@sveltejs/adapter-node': '6.0.4',
      '@sveltejs/vite-plugin-svelte': '7.3.1', svelte: '5.57.3', vite: '8.3.8' },
    files: {
      'vite.config.js': `import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
export default { plugins: [sveltekit({ adapter: adapter() })] };`,
      'src/app.html': '<!doctype html><html><head>%sveltekit.head%</head><body>%sveltekit.body%</body></html>',
      'src/routes/fixture/+server.js': `export const POST = ${fetchRoute};`,
    },
    rules: 'src/patchstack.rules.json',
    build: ['node_modules/vite/bin/vite.js', 'build'],
    start: ['build/index.js'],
  },
  nuxt: {
    dependencies: { nuxt: '4.6.4' },
    files: {
      'nuxt.config.ts': 'export default defineNuxtConfig({ telemetry: false });',
      'app/app.vue': '<template><div>Fixture</div></template>',
      'server/fixture-stream.ts': `let release: () => void;
export function finishStream() { release(); }
export async function* stream() {
  const finished = new Promise<void>(done => { release = done; });
  yield 'data: public\\n\\n';
  await finished;
  yield 'data: finished\\n\\n';
}`,
      'server/routes/stream.get.ts': `import { Readable } from 'node:stream';
import { sendStream, setResponseHeader } from 'h3';
import { stream } from '../fixture-stream';
export default defineEventHandler(event => {
  setResponseHeader(event, 'content-type', 'text/event-stream');
  setResponseHeader(event, 'x-fixture', 'fixture-stream-private');
  return sendStream(event, Readable.from(stream()));
});`,
      'server/routes/release.get.ts': `import { finishStream } from '../fixture-stream';
export default defineEventHandler(() => { finishStream(); return { ok: true }; });`,
      'server/routes/fixture.post.ts': `export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  return ${output};
});`,
    },
    rules: 'server/middleware/patchstack.rules.json',
    build: ['node_modules/.bin/nuxt', 'build'],
    start: ['.output/server/index.mjs'],
    stream: [''],
  },
  'react-router': {
    dependencies: { '@react-router/dev': '8.5.1', '@react-router/serve': '8.5.1', react: '19.3.1',
      'react-dom': '19.3.1', 'react-router': '8.5.1', vite: '8.3.8' },
    files: {
      'vite.config.js': `import { reactRouter } from '@react-router/dev/vite';
export default { plugins: [reactRouter()] };`,
      'react-router.config.ts': 'export default { ssr: true };',
      'app/root.tsx': `import { Outlet } from 'react-router';
export default function App() { return <Outlet />; }`,
      'app/routes.ts': `export default [{ path: 'fixture', file: 'fixture.js' }];`,
      'app/fixture.js': `export const action = ${fetchRoute};`,
    },
    rules: 'app/patchstack/patchstack.rules.json',
    build: ['node_modules/.bin/react-router', 'build'],
    start: ['node_modules/.bin/react-router-serve', './build/server/index.js'],
  },
  tanstack: {
    dependencies: { '@tanstack/react-start': '1.168.60', '@tanstack/react-router': '1.170.41',
      '@vitejs/plugin-react': '6.3.0', nitro: '3.0.261103-rc', react: '19.3.1', 'react-dom': '19.3.1', vite: '8.3.8' },
    files: {
      'vite.config.ts': `import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
export default defineConfig({ plugins: [tanstackStart(), react(), nitro({ preset: 'node-server' })] });`,
      'tsconfig.json': JSON.stringify({ compilerOptions: {
        jsx: 'react-jsx', module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', skipLibCheck: true,
      } }),
      'src/router.tsx': `import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
export function getRouter() { return createRouter({ routeTree }); }`,
      'src/routes/__root.tsx': `import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
export const Route = createRootRoute({
  component: () => <html><head><HeadContent /></head><body><Outlet /><Scripts /></body></html>,
});`,
      'src/routes/fixture.ts': `import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/fixture')({ server: { handlers: { POST: ${fetchRoute} } } });`,
    },
    rules: 'src/patchstack/rules.json',
    build: ['node_modules/.bin/vite', 'build'],
    start: ['.output/server/index.mjs'],
  },
  nestjs: {
    dependencies: { '@nestjs/core': '12.5.1', '@nestjs/common': '12.5.1',
      '@nestjs/platform-express': '12.5.1', 'reflect-metadata': '0.2.2', rxjs: '7.8.2' },
    files: {
      'server.cjs': `require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { Module, Controller, Post, Body, HttpCode } = require('@nestjs/common');
class Fixture {
  submit(body) { return ${output}; }
}
const method = Object.getOwnPropertyDescriptor(Fixture.prototype, 'submit');
Controller()(Fixture);
Post('fixture')(Fixture.prototype, 'submit', method);
HttpCode(200)(Fixture.prototype, 'submit', method);
Body()(Fixture.prototype, 'submit', 0);
class AppModule {}
Module({ controllers: [Fixture] })(AppModule);
async function main() {
  const app = await NestFactory.create(AppModule);
  await app.listen(Number(process.env.PORT), '127.0.0.1');
}
main();`,
    },
    rules: 'patchstack/rules.json',
    start: ['server.cjs'],
  },
};

function fastifyFixture(format) {
  const commonJs = format === 'cjs';
  const entry = commonJs ? 'server.cjs' : 'server.mjs';
  return {
    dependencies: { fastify: '5.12.1' },
    files: { [entry]: `
${commonJs ? "const defaultFastify = require('fastify'); const { fastify, errorCodes, LogController } = defaultFastify;" : "import defaultFastify, { fastify, errorCodes, LogController } from 'fastify';"}
if (defaultFastify !== fastify || defaultFastify.errorCodes !== errorCodes || !errorCodes
  || defaultFastify.LogController !== LogController || typeof LogController !== 'function') {
  throw new Error('Inconsistent Fastify exports');
}
${commonJs ? "const { Readable } = require('node:stream');" : "import { Readable } from 'node:stream';"}
const app = fastify();
let finishStream;
app.get('/release', async () => { finishStream(); return { ok: true }; });
app.get('/stream', async (request, reply) => {
  const release = new Promise(resolve => { finishStream = resolve; });
  const chunks = async function* () {
    yield 'data: public\\n\\n';
    await release;
    yield 'data: finished\\n\\n';
  };
  return reply.type(request.query.text ? 'text/plain' : 'text/event-stream').header('x-fixture', 'fixture-stream-private')
    .send(Readable.from(chunks()));
});
app.post('/fixture', async ({ body }) => ${output});
app.options('/fixture', async () => ({ ok: true }));
app.listen({ port: Number(process.env.PORT), host: '127.0.0.1' });
` },
    rules: 'patchstack/rules.json',
    start: [entry],
    stream: ['', '?text=1'],
  };
}

fixtures.fastify = fastifyFixture('cjs');
for (const format of ['esm', 'cjs']) {
  fixtures['fastify-startup-' + format] = {
    ...fastifyFixture(format),
    preload: true,
  };
}

// Run against an npm pack artifact on a Unix host. Framework packages are pinned per fixture.
const [name, tarball] = process.argv.slice(2);
assert.ok(Object.hasOwn(fixtures, name) && tarball, `Usage: node scripts/framework-consumers.mjs <${Object.keys(fixtures).join('|')}> <tarball>`);
const fixture = fixtures[name];
const live = process.env.PS_FASTIFY_LIVE === '1';
const localSaas = process.env.PS_FASTIFY_LOCAL_SAAS;
const fallbackRulesUrl = process.env.PS_FASTIFY_FALLBACK_RULES_URL;
const scopedRule = process.env.PS_FASTIFY_SCOPE_RULE;
const siteUuid = process.env.PATCHSTACK_SITE_UUID;
const apiKey = process.env.PATCHSTACK_API_KEY;
if (live) {
  assert.ok(fixture.preload && process.platform === 'linux', 'Live mode requires a Linux Fastify startup fixture.');
  assert.ok(siteUuid && apiKey, 'Live mode needs a dedicated sandbox site and API key.');
}
for (const endpoint of [localSaas, fallbackRulesUrl].filter(value => value !== undefined)) {
  assert.ok(live && /^http:\/\/127\.0\.0\.1:[0-9]+\/monitor\/pulse$/.test(endpoint),
    'The local SaaS endpoint must be an explicit loopback HTTP service.');
}
if (scopedRule !== undefined) {
  assert.ok(localSaas && scopedRule.trim(), 'Scoped enforcement checks require a local SaaS sandbox.');
}
if (fallbackRulesUrl !== undefined) {
  assert.ok(scopedRule, 'The fallback rules service needs a dedicated sandbox rule.');
}
const cwd = mkdtempSync(join(tmpdir(), 'ps-framework-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PATCHSTACK_') && key !== 'NODE_OPTIONS' && !key.startsWith('PS_FASTIFY_')));
Object.assign(env, { ASTRO_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1', CI: '1', HOST: '127.0.0.1' });
const put = (file, source) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), source);
};
function run(command, args, childEnv = env) {
  const child = spawnSync(command, args, { cwd, env: childEnv, encoding: 'utf8', timeout: 180_000 });
  assert.equal(child.status, 0, [child.error?.message, child.stdout, child.stderr].join('\n').replaceAll(cwd, '<fixture>'));
}
const fixtureSite = '11111111-1111-4111-8111-111111111111';
let localRulesUrl;

async function check(protectedApp, liveBuild) {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  const processEnv = { ...env, PORT: String(port), ORIGIN: `http://127.0.0.1:${port}` };
  if (liveBuild) {
    const rulesUrl = liveBuild.rulesUrl ?? localSaas;
    Object.assign(processEnv, {
      PS_FASTIFY_LIVE: '1', PS_FASTIFY_EXPECT_MATCH: liveBuild.matched ? '1' : '0',
      PATCHSTACK_SITE_UUID: siteUuid, PATCHSTACK_API_KEY: apiKey,
      PATCHSTACK_DEPLOYMENT_FILE: liveBuild.file, PATCHSTACK_ENVIRONMENT: 'sandbox',
      PATCHSTACK_MODE: scopedRule ? 'block' : 'dry-run',
      ...(rulesUrl ? { PATCHSTACK_PULSE_RULES_URL: rulesUrl } : {}),
      ...(scopedRule ? {
        PS_FASTIFY_SCOPE_RULE: scopedRule,
        PS_FASTIFY_SCOPE_EXPECT: liveBuild.scopedOutcome,
      } : {}),
    });
  } else if (protectedApp && localRulesUrl) {
    Object.assign(processEnv, {
      PATCHSTACK_SITE_UUID: fixtureSite,
      PATCHSTACK_API_KEY: 'synthetic-key-1',
      PATCHSTACK_PULSE_RULES_URL: localRulesUrl,
      PATCHSTACK_MODE: 'block',
    });
  }
  const flags = protectedApp && fixture.preload ? ['--import', '@patchstack/connect/register/fastify'] : [];
  if (liveBuild) flags.push('--import', './host/live.mjs');
  const app = spawn(process.execPath, [...flags, ...fixture.start], { cwd, env: processEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const stream of [app.stdout, app.stderr]) stream.on('data', part => { log += part; });
  const post = label => fetch(processEnv.ORIGIN + '/fixture', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
    signal: AbortSignal.timeout(3000),
  });
  let scopedCheckCompleted = false;
  try {
    let normal;
    for (let attempt = 0; attempt < (liveBuild ? 350 : 200) && app.exitCode === null; attempt++) {
      try { normal = await post('ordinary'); break; } catch { await new Promise(done => setTimeout(done, 100)); }
    }
    assert.equal(normal?.status, 200, log.replaceAll(cwd, '<fixture>'));
    const result = await normal.json();
    assert.equal(result.label, 'ordinary');
    assert.equal(typeof result.sample, 'string');
    if (liveBuild) {
      const reported = log.split('\n').find(line => line.startsWith('Fastify live pilot '));
      assert.ok(reported, 'The host startup hook did not report SaaS rule delivery.');
      const url = processEnv.ORIGIN + '/fixture';
      const challenge = await activationChallenge(apiKey, url);
      const probe = await fetch(url, {
        method: 'OPTIONS', redirect: 'error', headers: { [ACTIVATION_HEADER]: challenge },
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(probe.status, 200);
      const status = await verifyActivationResponse(apiKey, challenge, await probe.text(), probe.headers.get(ACTIVATION_HEADER));
      const { buildId } = JSON.parse(readFileSync(join(cwd, liveBuild.file), 'utf8'));
      assert.ok(status, 'Fastify did not return a signed activation response.');
      assert.equal(status.siteUuid, siteUuid);
      assert.equal(status.buildId, buildId);
      assert.equal(status.matched, liveBuild.matched);
      assert.equal(status.source.ok, true);
      assert.equal(status.source.origin, 'api');
      console.log(reported);
      if (scopedRule) {
        assert.equal(status.mode, 'block');
        const response = await post('fixture-block');
        assert.equal(response.status, liveBuild.scopedOutcome === 'block' ? 403 : 200);
        const body = await response.json();
        if (liveBuild.scopedOutcome !== 'block') assert.equal(body.label, 'fixture-block');
        console.log(`Scoped rule (${liveBuild.scopedOutcome}): HTTP ${response.status}`);
        scopedCheckCompleted = true;
      }
      return;
    }
    if (protectedApp) assert.doesNotMatch(result.sample, /fixture-private/);
    else assert.equal(result.sample, 'fixture-private');
    assert.equal((await post('fixture-block')).status, protectedApp ? 403 : 200);
    if (fixture.stream) {
      for (const suffix of fixture.stream) {
        const stream = await fetch(processEnv.ORIGIN + '/stream' + suffix, { signal: AbortSignal.timeout(3000) });
        assert.equal(stream.status, 200);
        const header = stream.headers.get('x-fixture');
        assert.equal(typeof header, 'string');
        if (protectedApp) assert.doesNotMatch(header, /fixture-stream-private/);
        else assert.equal(header, 'fixture-stream-private');
        const reader = stream.body.getReader();
        const decoder = new TextDecoder();
        let first = '';
        while (!first.endsWith('\n\n')) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          first += decoder.decode(chunk.value);
        }
        assert.equal(first, 'data: public\n\n');
        const release = await fetch(processEnv.ORIGIN + '/release', { signal: AbortSignal.timeout(3000) });
        assert.equal(release.status, 200);
        await release.text();
        let rest = '';
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += decoder.decode(chunk.value);
        assert.equal(rest, 'data: finished\n\n');
      }
    }
  } finally {
    if (app.exitCode === null) {
      const exited = once(app, 'exit');
      const timer = setTimeout(() => app.kill('SIGKILL'), scopedRule ? 8000 : 3000);
      app.kill('SIGTERM');
      try {
        const [code] = await exited;
        if (scopedCheckCompleted) assert.equal(code, 0, 'The guard must drain detections before exiting.');
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
let mockRules;
try {
  put('package.json', JSON.stringify({ name: 'framework-fixture', private: true, type: 'module',
    dependencies: { ...fixture.dependencies, '@patchstack/connect': `file:${resolve(tarball)}` } }));
  for (const [file, source] of Object.entries(fixture.files)) put(file, source);
  run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts']);
  if (fixture.build) run(process.execPath, fixture.build);
  await check(false);
  const packageDir = 'node_modules/@patchstack/connect';
  if (fixture.preload) {
    if (live) {
      mkdirSync(join(cwd, 'host'), { recursive: true });
      copyFileSync(fileURLToPath(new URL('./fastify-startup-live.mjs', import.meta.url)), join(cwd, 'host/live.mjs'));
    }
  } else {
    const cli = join(packageDir, 'dist/cli.js');
    run(process.execPath, [cli, 'protect']);
    run(process.execPath, [cli, 'protect', '--check']);
    readFileSync(join(cwd, fixture.rules));
  }
  const fixtureBundle = JSON.stringify({ firewall: [
    { id: 'fixture-request', rule_v2: [{ parameter: 'post.label', match: { type: 'equals', value: 'fixture-block' } }] },
    { id: 'fixture-response', phase: 'response', action: 'redact', when: { path: '/fixture', method: 'POST' },
      rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'fixture-private' } }] },
    { id: 'fixture-stream-header', phase: 'response', action: 'redact', when: { path: '/stream' },
      rule_v2: [{ parameter: 'response.header.x-fixture', match: { type: 'regex', value: '/fixture-stream-private/' } }] },
  ], whitelists: [], whitelist_keys: {} });
  if (fixture.preload && !live) {
    mockRules = createHttpServer((incoming, reply) => {
      incoming.resume();
      if (incoming.method === 'POST' && incoming.url === '/monitor/pulse/token') {
        reply.writeHead(200, { 'content-type': 'application/json' }).end('{"access_token":"synthetic-token"}');
      } else if (incoming.method === 'GET' && incoming.url === `/monitor/pulse/rules/${fixtureSite}`
        && incoming.headers.authorization === 'Bearer synthetic-token') {
        reply.writeHead(200, { 'content-type': 'application/json' }).end(fixtureBundle);
      } else {
        reply.writeHead(404).end();
      }
    });
    mockRules.listen(0, '127.0.0.1');
    await once(mockRules, 'listening');
    localRulesUrl = `http://127.0.0.1:${mockRules.address().port}/monitor/pulse`;
  } else if (!fixture.preload) {
    put(fixture.rules, fixtureBundle);
  }
  if (fixture.build) run(process.execPath, fixture.build);
  if (live) {
    const deployment = 'host/deployment.json';
    run(process.execPath, [join(packageDir, 'dist/cli.js'), 'prepare-deploy', '--out', deployment], {
      ...env, PATCHSTACK_SITE_UUID: siteUuid, PATCHSTACK_API_KEY: apiKey, PATCHSTACK_ENVIRONMENT: 'sandbox',
      ...(localSaas ? { PATCHSTACK_ENDPOINT: localSaas + '/manifest' } : {}),
    });
    await check(true, { file: deployment, matched: true, scopedOutcome: 'block' });
    const unmatched = JSON.parse(readFileSync(join(cwd, deployment), 'utf8'));
    unmatched.buildId = (unmatched.buildId[0] === '0' ? '1' : '0') + unmatched.buildId.slice(1);
    put('host/unmatched.json', JSON.stringify(unmatched));
    const mismatch = { file: 'host/unmatched.json', matched: false };
    await check(true, { ...mismatch, scopedOutcome: 'absent' });
    if (fallbackRulesUrl) {
      await check(true, { ...mismatch, scopedOutcome: 'detect', rulesUrl: fallbackRulesUrl });
    }
  } else {
    await check(true);
  }
  if (fixture.preload) {
    for (const [file, source] of Object.entries(fixture.files)) assert.equal(readFileSync(join(cwd, file), 'utf8'), source);
  }
  if (live) console.log(`PASS ${name}: Linux live-rule and build-identity checks with unchanged application source`);
  else console.log(`PASS ${name}: HTTP request screening, normal body parsing and response redaction${fixture.stream ? ' including stream headers' : ''}`);
} finally {
  mockRules?.close();
  mockRules?.closeAllConnections();
  rmSync(cwd, { recursive: true, force: true });
}
