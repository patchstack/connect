import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
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
async function loadPlugin(): Promise<(fastify: unknown) => Promise<void>> {
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

  const protection = await createProtection({ mode: 'block', rules: RULES as never });
  protections.push(protection);
  (globalThis as Record<string, unknown>).__psTestProtection = protection;

  const dir = mkdtempSync(join(tmpdir(), 'ps-fastify-'));
  dirs.push(dir);
  const file = join(dir, 'plugin.mjs');
  writeFileSync(file, source);

  const mod = (await import(pathToFileURL(file).href)) as { patchstackFastify: (fastify: unknown) => Promise<void> };

  return mod.patchstackFastify;
}

describe('the scaffolded Fastify plugin', () => {
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
