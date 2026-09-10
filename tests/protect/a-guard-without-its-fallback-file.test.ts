import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * What a scaffolded guard does when the rules file beside it cannot be used.
 *
 * It loads, and it holds no local bundle. The guard is imported on the app's own module path — a seam
 * file, a middleware, a server entry — so a throw while loading it is the app failing to boot, which no
 * rule is worth. The file can be absent for ordinary reasons: a bundler that copied no JSON, a partial
 * deploy, a half-written edit.
 *
 * Three things make that a whole answer, so all three are asserted: the guard offers what it offers with
 * the file present, it passes `rules: undefined` rather than a policy nobody wrote, and it says on the
 * console that the file was not read.
 */
const TEMPLATE_DIR = new URL('../../src/protect/templates/', import.meta.url);
/** The seam imports the verification sentinel from the package, so a stubbed package has to carry it. */
const INERT = "sentinelAnswer: async () => null, VERIFY_HEADER: 'x-patchstack-verify'";
const RUNTIME_TEMPLATES = readdirSync(new URL(TEMPLATE_DIR)).filter((name) => /\.(?:js|cjs)$/.test(name));
const WHOLE_FILE = readFileSync(new URL('rules.json', TEMPLATE_DIR), 'utf8');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__psOptions;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** What the guard asked `createProtection` for, in order. */
function asked(): Array<Record<string, unknown>> {
  return ((globalThis as Record<string, unknown>).__psOptions as Array<Record<string, unknown>>) ?? [];
}

/**
 * The template as an app receives it, with only its import of the published package redirected — to a
 * factory that records what it was asked for and hands back nothing usable, since what the guard does
 * with a protection is not what these assert.
 *
 * `rules` is the content of the rules file beside it, or null to leave the file out entirely.
 */
async function loadGuard(name: string, rules: string | null): Promise<Record<string, unknown>> {
  const commonjs = name.endsWith('.cjs');
  const dir = mkdtempSync(join(tmpdir(), 'ps-fallback-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: commonjs ? 'commonjs' : 'module' }));

  // A protection complete enough for each seam to use: what these cases are about is the bundle it was
  // asked for, so nothing here should fail for want of a method.
  const usable =
    '{ express: () => (_req, _res, next) => next(), node: () => (_req, _res, next) => next(),' +
    ' fetchGuard: () => async () => null, screenResponse: async (response) => response }';
  const record = `async (options) => { (globalThis.__psOptions ??= []).push(options); return ${usable}; }`;
  const stub = commonjs ? 'stub.cjs' : 'stub.mjs';
  writeFileSync(
    join(dir, stub),
    commonjs
      ? `module.exports = { createProtection: ${record}, ${INERT} };\n`
      : `export const createProtection = ${record};\nexport const sentinelAnswer = async () => null;\nexport const VERIFY_HEADER = 'x-patchstack-verify';\n`,
  );

  const source = readFileSync(new URL(name, TEMPLATE_DIR), 'utf8').replace(
    '"@patchstack/connect/protect"',
    JSON.stringify(`./${stub}`),
  );
  const file = join(dir, name);
  writeFileSync(file, source);
  if (rules !== null) writeFileSync(join(dir, 'rules.json'), rules);

  const loaded: any = await import(pathToFileURL(file).href);

  // A CommonJS template arrives as a default export; either way what is asserted is what it offers.
  return loaded.default ?? loaded;
}

/**
 * Make the guard build its protection, which is when the bundle is handed over.
 *
 * Each template offers a different way in, and every one of them builds on first use. Whatever the
 * template then does with a protection that is only a marker is not this file's subject, so it is
 * allowed to fail — `asked()` is empty if the build never happened, and that fails the assertion.
 */
async function build(api: Record<string, any>): Promise<void> {
  try {
    if (typeof api.getProtection === 'function') await api.getProtection();
    else if (typeof api.patchstackFastify === 'function') {
      // The Fastify plugin builds on the first request its hook sees, not at registration, so the hook
      // is what has to run.
      const hooks: Array<(request: unknown, reply: unknown) => unknown> = [];
      await api.patchstackFastify({ addHook: (_event: string, hook: never) => hooks.push(hook) });
      for (const hook of hooks) {
        await hook({ method: 'GET', url: '/', headers: {} }, { code: () => {}, header: () => {}, send: () => {} });
      }
    } else await api.patchstackMiddleware({ method: 'GET', url: '/', headers: {} }, { setHeader: () => {} }, () => {});
  } catch {
    // The stub is not a policy.
  }
  // The express-style seam builds on a promise it does not return.
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('a scaffolded guard whose rules file cannot be used', () => {
  it('covers every template an app receives as a file it reads', () => {
    expect(RUNTIME_TEMPLATES.length).toBeGreaterThan(5);
  });

  for (const name of RUNTIME_TEMPLATES) {
    for (const [what, rules] of [['is missing', null], ['holds truncated JSON', '{"firewall": [']] as const) {
      it(`${name}: loads and holds no local bundle when the file ${what}`, async () => {
        // No site and no token, so the bundle is the only rule source the guard is choosing about.
        vi.stubEnv('PATCHSTACK_SITE_UUID', '');
        vi.stubEnv('PATCHSTACK_WAF_TOKEN', '');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // The control: the same template, with the file it ships with.
        const complete = Object.keys(await loadGuard(name, WHOLE_FILE)).sort();
        await build(await loadGuard(name, WHOLE_FILE));
        expect(warn, 'a readable file is not worth a warning').not.toHaveBeenCalled();
        expect(asked().at(-1)?.rules, 'the control proves the file is what `rules` carries').toEqual(
          JSON.parse(WHOLE_FILE),
        );

        warn.mockClear();
        delete (globalThis as Record<string, unknown>).__psOptions;

        const api = await loadGuard(name, rules);

        // The same guard, not a smaller one: an app that loses its rules file keeps every helper it wired.
        expect(Object.keys(api).sort()).toEqual(complete);
        expect(complete.length).toBeGreaterThan(0);

        await build(api);
        expect(asked()).toHaveLength(1);
        // Undefined, and not a bundle invented in the catch: the runtime reads absence as no local
        // bundle, while any substitute would be policy the app never authored.
        expect(asked()[0].rules).toBeUndefined();

        expect(warn, 'the load that failed is the one that reports').toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('rules.json');
      });
    }
  }
});
