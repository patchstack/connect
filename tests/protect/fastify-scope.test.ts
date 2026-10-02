import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * The scaffolded Fastify plugin, run through a real Fastify app.
 *
 * Fastify encapsulates a registered plugin: a hook added inside one applies to that plugin's context and
 * its children, and to nothing else. So a guard registered as an ordinary plugin screens nothing on the
 * root instance and nothing in sibling route plugins — which is most of an application, while the install
 * and the verification both report it wired.
 *
 * Nothing short of booting Fastify establishes this. The template can be read, the registration can be
 * asserted, and both were: encapsulation is a property of the framework, not of the text.
 *
 * The template is compiled here rather than imported, because it ships as a scaffolded FILE and the
 * question is whether what we scaffold works. The one thing substituted is the protection factory — the
 * template builds its own from a site UUID, which would reach the network.
 */
const TEMPLATE = new URL('../../src/protect/templates/fastify-plugin.js', import.meta.url);

const RULES = {
  firewall: [
    {
      id: 'rm-fastify-scope',
      title: 'test rule',
      rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }],
    },
  ],
  whitelists: [],
};

const dirs: string[] = [];
const protections: Array<{ stop: () => void }> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const protection of protections.splice(0)) protection.stop();
  delete (globalThis as Record<string, unknown>).__psTestProtection;
});

/**
 * Load the scaffolded plugin with its protection factory replaced.
 *
 * Written to a temp file and imported, so the module the test exercises is the module we ship — the
 * substitution is one function body, and the export, the hook registration and the encapsulation marker
 * are the template's own.
 */
async function loadPlugin(rules = RULES): Promise<(fastify: unknown) => Promise<void>> {
  // The protection is passed in through a global rather than imported by the generated module: the
  // template's own import of the published package cannot resolve from a temp directory, and rewriting it
  // to an absolute path is the one substitution that would let a broken relative import pass unnoticed.
  const source = readFileSync(TEMPLATE, 'utf8')
    .replace(/^import .*$/gm, '')
    // The fallback bundle is read from a sibling file the scaffolder also writes, which a temp directory
    // does not have. Replaced rather than provided: the template's fallback path is not what these tests
    // are about, and a stub keeps the substitution to one expression.
    .replace(/^const fallbackRules = .*$/m, 'const fallbackRules = { firewall: [], whitelists: [] };')
    .replace(
      /async function getProtection\(\)[\s\S]*?\n}/,
      'async function getProtection() { return globalThis.__psTestProtection; }',
    );

  // The imports this strips include the verification sentinel, so it is supplied inert: none of these
  // requests is a verification, and the seam has to behave as it does for ordinary traffic.
  const preamble = 'const sentinelAnswer = async () => null;\nconst VERIFY_HEADER = "x-patchstack-verify";\n';

  const protection = await createProtection({ mode: 'block', rules: rules as never, reportDetections: false, reportFirewallLog: false });
  protections.push(protection);
  (globalThis as Record<string, unknown>).__psTestProtection = protection;

  const dir = mkdtempSync(join(tmpdir(), 'ps-fastify-'));
  dirs.push(dir);
  const file = join(dir, 'plugin.mjs');
  writeFileSync(file, preamble + source);

  const mod = (await import(pathToFileURL(file).href)) as { patchstackFastify: (fastify: unknown) => Promise<void> };

  return mod.patchstackFastify;
}

describe('the scaffolded Fastify plugin', () => {
  it('screens parsed form and JSON fields equally without mutating the route body', async () => {
    const plugin = await loadPlugin({firewall:[{id:'synthetic-form',title:'form',rule_v2:[{parameter:'post.message',match:{type:'contains',value:'synthetic-block'}}]}],whitelists:[]});
    const app = Fastify();
    app.addContentTypeParser('application/x-www-form-urlencoded', {parseAs:'string'}, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
    await app.register(plugin);
    app.post('/contact', async req => ({ body:req.body, type:req.headers['content-type'] }));
    try {
      for (const type of ['application/json', 'application/x-www-form-urlencoded']) {
        const encode = (message: string) => type === 'application/json' ? JSON.stringify({message}) : new URLSearchParams({message}).toString();
        expect((await app.inject({method:'POST',url:'/contact',headers:{'content-type':type},payload:encode('synthetic-block')})).statusCode).toBe(403);
        const allowed = await app.inject({method:'POST',url:'/contact',headers:{'content-type':type},payload:encode('hello')});
        expect(allowed.statusCode).toBe(200);
        expect(allowed.json()).toEqual({body:{message:'hello'},type});
      }
    } finally { await app.close(); }
  });

  it('redacts serialized output, preserves cookies and lets live streams pass through', async () => {
    const plugin = await loadPlugin({firewall:[{id:'synthetic-response',title:'redact',phase:'response',action:'redact',rule_v2:[{parameter:'response.body',match:{type:'contains',value:'synthetic-secret'}}]}] as never,whitelists:[]});
    const app = Fastify();
    await app.register(plugin);
    app.get('/text', async (_req, reply) => reply.header('set-cookie',['first=1; Path=/','second=2; Path=/']).type('text/plain').send('synthetic-secret'));
    app.get('/stream', async (_req, reply) => reply.type('text/event-stream').send(Readable.from(['data: public\n\n'])));
    app.get('/empty', async (_req, reply) => reply.code(204).send());
    try {
      const redacted = await app.inject('/text');
      expect(redacted.statusCode).toBe(200);
      expect(redacted.body).not.toContain('synthetic-secret');
      expect(redacted.headers['set-cookie']).toEqual(['first=1; Path=/','second=2; Path=/']);
      expect(Number(redacted.headers['content-length'])).toBe(Buffer.byteLength(redacted.body));
      expect((await app.inject('/stream')).body).toBe('data: public\n\n');
      expect((await app.inject('/empty')).statusCode).toBe(204);
    } finally { await app.close(); }
  });
  it('screens a route registered on the root instance', async () => {
    // The plain case, and the one encapsulation breaks: `app.get(...)` on the same instance the guard was
    // registered on is a SIBLING of the plugin's context, not a child of it.
    const patchstackFastify = await loadPlugin();
    const app = Fastify();

    await app.register(patchstackFastify as never);
    app.get('/', async () => 'ok');

    const blocked = await app.inject({ method: 'GET', url: '/?q=boom' });
    expect(blocked.statusCode).toBe(403);

    await app.close();
  });

  it('screens a route inside a sibling plugin', async () => {
    // How a real application is organised: routes live in their own plugins, registered beside the guard
    // rather than under it. An encapsulated hook reaches none of them.
    const patchstackFastify = await loadPlugin();
    const app = Fastify();

    await app.register(patchstackFastify as never);
    await app.register(async (instance) => {
      instance.get('/orders', async () => 'ok');
    });

    const blocked = await app.inject({ method: 'GET', url: '/orders?q=boom' });
    expect(blocked.statusCode).toBe(403);

    await app.close();
  });

  it('screens a route registered before the guard', async () => {
    // Registration order is the app author's, not ours. A guard that only covered what came after it would
    // be a guard whose coverage depended on where the installer happened to insert a line.
    const patchstackFastify = await loadPlugin();
    const app = Fastify();

    app.get('/early', async () => 'ok');
    await app.register(patchstackFastify as never);

    const blocked = await app.inject({ method: 'GET', url: '/early?q=boom' });
    expect(blocked.statusCode).toBe(403);

    await app.close();
  });

  it('lets an off-scope request through, everywhere it screens', async () => {
    // The control. Without it every assertion above would also pass for a plugin that refused everything,
    // which is not protection either.
    const patchstackFastify = await loadPlugin();
    const app = Fastify();

    await app.register(patchstackFastify as never);
    app.get('/', async () => 'root');
    await app.register(async (instance) => {
      instance.get('/orders', async () => 'orders');
    });

    for (const url of ['/?q=fine', '/orders?q=fine']) {
      const allowed = await app.inject({ method: 'GET', url });
      expect(allowed.statusCode, url).toBe(200);
    }

    await app.close();
  });

  it('carries the marker that breaks encapsulation', async () => {
    // Asserted directly as well, because the tests above would keep passing if a future Fastify made
    // encapsulation looser — and then the marker could be dropped without anything noticing until the
    // version that made it matter again.
    const patchstackFastify = await loadPlugin();

    expect((patchstackFastify as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')]).toBe(true);
  });

  it('ships that marker in every scaffolded variant', () => {
    // Three files are scaffolded depending on the target's module format, and the one a given app receives
    // is the one that has to work. A fix in the TypeScript variant alone would leave CommonJS apps inert.
    for (const file of ['fastify-plugin.ts', 'fastify-plugin.js', 'fastify-plugin.cjs']) {
      const source = readFileSync(new URL(`../../src/protect/templates/${file}`, import.meta.url), 'utf8');
      expect(source, file).toContain('Symbol.for("skip-override")');
    }
  });
});

describe('the guard the plugin builds on', () => {
  it('answers the request phase, which is what the hook depends on', async () => {
    // Separates a plugin-wiring failure from a rule failure: if this passes and the injections above do
    // not, the difference is the wiring.
    const protection = await createProtection({ mode: 'block', rules: RULES as never });
    const guard = protection.fetchGuard();

    expect(await guard(new Request('http://app.test/?q=boom'))).not.toBeNull();
    expect(await guard(new Request('http://app.test/?q=fine'))).toBeNull();

    protection.stop();
  });
});
