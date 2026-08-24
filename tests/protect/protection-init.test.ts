import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * How many protection policies a scaffolded guard builds when several requests arrive on a cold start.
 *
 * One, and the app is meant to have one: a policy owns a rule fetch and a refresh timer, so an extra one is
 * an extra poll loop against the rule endpoint for the life of the process, and two policies that refresh
 * independently can be screening by different rules at the same moment.
 */
const TEMPLATE_DIR = new URL('../../src/protect/templates/', import.meta.url);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__psCreate;
});

/**
 * Load a scaffolded guard with its protection factory replaced by one the test controls.
 *
 * The module under test is the file we ship; the factory is redirected through a global because the
 * template's import of the published package cannot resolve from a temp directory.
 */
async function loadGuard(name: string): Promise<{ getProtection: () => Promise<unknown> }> {
  const source = readFileSync(new URL(name, TEMPLATE_DIR), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^const fallbackRules = .*$/m, 'const fallbackRules = { firewall: [], whitelists: [] };')
    .replace(/^const PS_SITE_UUID = .*$/m, 'const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";');

  const dir = mkdtempSync(join(tmpdir(), 'ps-init-'));
  dirs.push(dir);
  const file = join(dir, 'guard.mjs');
  writeFileSync(
    file,
    ['const createProtection = (options) => globalThis.__psCreate(options);', source, 'export { getProtection };'].join(
      '\n',
    ),
  );

  return import(pathToFileURL(file).href) as Promise<{ getProtection: () => Promise<unknown> }>;
}

describe('a guard asked for its protection by several requests at once', () => {
  it('builds one policy, not one per request', async () => {
    let builds = 0;
    (globalThis as Record<string, unknown>).__psCreate = async () => {
      builds++;
      // The window that makes this observable: between the first request starting the build and it
      // finishing, every other request finds the cache and has to join rather than start its own.
      await new Promise((resolve) => setTimeout(resolve, 10));

      return { id: builds };
    };

    const { getProtection } = await loadGuard('generic-guard.js');
    const resolved = await Promise.all(Array.from({ length: 8 }, () => getProtection()));

    expect(builds).toBe(1);
    // And they all hold the same one, rather than eight policies that happen to look alike.
    for (const one of resolved) expect(one).toBe(resolved[0]);
  });

  it('retries after a build that failed instead of caching the failure', async () => {
    // The reason the slot is cleared on rejection. A cold start that fails once — a rule endpoint briefly
    // unreachable — must not leave the process holding a rejected promise it hands to every later request.
    let attempts = 0;
    (globalThis as Record<string, unknown>).__psCreate = async () => {
      attempts++;
      if (attempts === 1) throw new Error('boot failed');

      return { id: attempts };
    };

    const { getProtection } = await loadGuard('generic-guard.js');

    await expect(getProtection()).rejects.toThrow('boot failed');
    await expect(getProtection()).resolves.toEqual({ id: 2 });
  });
});

describe('every scaffolded guard', () => {
  it('caches the in-flight build rather than the finished value', () => {
    // Asserted across all of them because each stack gets its own template, and the one an app receives is
    // the one that has to hold a single policy. `slot = await createProtection(...)` is the shape that
    // leaves the cache empty for the whole length of the build.
    const templates = readdirSync(new URL(TEMPLATE_DIR)).filter((name) => /\.(?:ts|js|cjs)$/.test(name));
    expect(templates.length).toBeGreaterThan(5);

    for (const name of templates) {
      const source = readFileSync(new URL(name, TEMPLATE_DIR), 'utf8');
      if (!/createProtection\(/.test(source)) continue;

      expect(source, name).not.toMatch(/\b_?protection\s*=\s*await createProtection\(/);
      expect(source, name).toMatch(/\b_?protection\s*=\s*buildProtection\(\)/);
    }
  });
});
