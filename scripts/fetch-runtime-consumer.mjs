import assert from 'node:assert/strict';

const name = typeof Bun === 'undefined' ? 'deno' : 'bun';
assert.ok(name === 'bun' || typeof Deno !== 'undefined', 'Run this fixture with Bun or Deno.');
const dist = new URL('../dist/', import.meta.url);
const { createProtection } = await import(new URL(name === 'deno' ? 'protect.edge.js' : 'protect.js', dist));

const specifier = 'fixture:connect-runtime';
if (name === 'bun') {
  Bun.plugin({
    name: 'Connect runtime fixture',
    setup(build) {
      build.onResolve({ filter: /^connect-runtime$/, namespace: 'fixture' }, ({ path }) => ({
        path, namespace: 'fixture',
      }));
      build.onLoad({ filter: /^connect-runtime$/, namespace: 'fixture' }, () => ({
        exports: { tag: 'fixture-ordinary' }, loader: 'object',
      }));
    },
  });
} else {
  const { registerHooks } = await import('node:module');
  const virtual = new URL('./connect-fake-fixture.mjs', import.meta.url).href;
  registerHooks({
    resolve(request, context, next) {
      return request === specifier ? { url: virtual, shortCircuit: true } : next(request, context);
    },
    load(url, context, next) {
      return url === virtual
        ? { format: 'module', source: 'export const tag = "fixture-ordinary"', shortCircuit: true }
        : next(url, context);
    },
  });
}
const { tag } = await import(specifier);
assert.equal(tag, 'fixture-ordinary');

const protection = await createProtection({
  mode: 'block',
  rules: { firewall: [
    { id: 'synthetic-request', rule_v2: [{ parameter: 'post.label', match: { type: 'equals', value: 'fixture-block' } }] },
    { id: 'synthetic-response', phase: 'response', action: 'redact',
      rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'fixture-private' } }] },
  ], whitelists: [], whitelist_keys: {} },
});
const handle = protection.fetch(async request =>
  Response.json({ body: await request.json(), sample: 'fixture-private' }));
const options = { hostname: '127.0.0.1', port: 0 };
const server = name === 'bun' ? Bun.serve({ ...options, fetch: handle }) : Deno.serve({ ...options, onListen() {} }, handle);
try {
  const port = name === 'bun' ? server.port : server.addr.port;
  const post = label => fetch(`http://127.0.0.1:${port}/fixture`, {
    method: 'POST', signal: AbortSignal.timeout(2000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
  });
  const allowed = await post(tag);
  assert.equal(allowed.status, 200);
  const result = await allowed.json();
  assert.deepEqual(result.body, { label: tag });
  assert.equal(typeof result.sample, 'string');
  assert.doesNotMatch(result.sample, /fixture-private/);
  const blocked = await post('fixture-block');
  assert.equal(blocked.status, 403);
  await blocked.text();
  const version = name === 'bun' ? Bun.version : Deno.version.deno;
  console.log(`PASS ${name} ${version}: module hook and native Fetch request/response screening`);
} finally {
  if (name === 'bun') await server.stop(true);
  else await server.shutdown();
  await protection.stop();
}
