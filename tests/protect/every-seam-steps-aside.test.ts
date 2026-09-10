import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';

/**
 * What each generated seam does when it cannot get a protection.
 *
 * The app answers. A seam runs on the app's own request path, so a failure it lets through is not a
 * guard declining to screen — it is the request failing, or the process failing to start.
 *
 * Covered per SEAM and not per template: one template can expose several, each reaching its protection
 * in its own way, and the inventory below is read out of the templates so an export added to an existing
 * one arrives uncovered and says so.
 *
 * Two properties beyond "no throw", and they are why the seams do not simply wrap themselves:
 *
 *   - the app's own work happens EXACTLY once. Only getting the protection is caught, so an exception of
 *     the app's stays the app's and no request is passed on twice.
 *   - what the seam returns is the app's answer, unscreened, rather than a substitute for it.
 */
const TEMPLATE_DIR = new URL('../../src/protect/templates/', import.meta.url);
const RULES = JSON.stringify({ firewall: [], whitelists: [] });

const REQUEST = () => new Request('https://app.example.com/x');
const NODE_REQUEST = { method: 'GET', url: '/x', headers: { host: 'app.example.com' } };
const REPLY = { code: () => {}, header: () => {}, send: () => {} };

/** A factory that cannot produce a protection at all. */
const REJECTS = 'async () => { globalThis.__psAttempts = (globalThis.__psAttempts ?? 0) + 1; throw new Error("no protection here"); }';

/**
 * A factory whose protection passes the request on and THEN fails.
 *
 * The shape that decides whether a seam can pass one request on twice: the app has already had its turn
 * when the failure arrives, so a handler that reads it as "the guard never ran" would repeat it.
 */
const FAILS_AFTER_PASSING_ON =
  'async () => ({ express: () => (_req, _res, next) => { next(); return Promise.reject(new Error("after the app")); },' +
  ' node: () => (_req, _res, next) => { next(); return Promise.reject(new Error("after the app")); } })';

/** Fails the first `n` builds, then hands over a protection that blocks everything. */
const RECOVERS_AFTER = (n: number) =>
  `async () => {
    globalThis.__psAttempts = (globalThis.__psAttempts ?? 0) + 1;
    if (globalThis.__psAttempts <= ${n}) throw new Error("attempt " + globalThis.__psAttempts + " failed");
    return {
      fetchGuard: () => async () => new Response("screened", { status: 403 }),
      screenResponse: async (response) => response,
    };
  }`;

const attempts = (): number => ((globalThis as Record<string, unknown>).__psAttempts as number) ?? 0;

/** Register the plugin, keep the hooks it added, and run each one against a request. */
async function throughFastifyHooks(api: Record<string, any>, reply: unknown = REPLY): Promise<void> {
  const hooks: Array<(request: unknown, reply: unknown) => unknown> = [];
  await api.patchstackFastify({ addHook: (_event: string, hook: never) => hooks.push(hook) });
  expect(hooks.length, 'registration adds the hook').toBeGreaterThan(0);
  for (const hook of hooks) await hook(NODE_REQUEST, reply);
}

/** How to drive one seam, and what it hands back when it has no protection. */
type Seam = (api: Record<string, any>, served: Response, ran: () => void) => Promise<unknown>;

const fetchSeam: Seam = async (api, served, ran) => api.protectFetch(async () => (ran(), served))(REQUEST());
const nodeSeam: Seam = async (api, _served, ran) =>
  new Promise((resolve) => api.patchstackMiddleware(NODE_REQUEST, {}, () => (ran(), resolve(undefined))));
const fastifySeam: Seam = async (api, _served, ran) => (ran(), throughFastifyHooks(api));

const SEAMS: Record<string, Seam> = {
  'generic-guard.ts#protectFetch': fetchSeam,
  'generic-guard.js#protectFetch': fetchSeam,
  'generic-guard.cjs#protectFetch': fetchSeam,
  'generic-guard.ts#patchstackMiddleware': nodeSeam,
  'generic-guard.js#patchstackMiddleware': nodeSeam,
  'generic-guard.cjs#patchstackMiddleware': nodeSeam,

  'express-guard.ts#patchstackMiddleware': nodeSeam,
  'express-guard.js#patchstackMiddleware': nodeSeam,
  'express-guard.cjs#patchstackMiddleware': nodeSeam,

  'fastify-plugin.ts#patchstackFastify': fastifySeam,
  'fastify-plugin.js#patchstackFastify': fastifySeam,
  'fastify-plugin.cjs#patchstackFastify': fastifySeam,

  'astro-middleware.ts#onRequest': async (api, served, ran) =>
    api.onRequest({ request: REQUEST() }, async () => (ran(), served)),
  'sveltekit-hooks.ts#handle': async (api, served, ran) =>
    api.handle({ event: { request: REQUEST() }, resolve: async () => (ran(), served) }),
  // Next and Nuxt fall through by answering nothing; the route runs after the middleware returns.
  'next-middleware.ts#middleware': async (api, _served, ran) => (ran(), api.middleware(REQUEST())),
  'nuxt-middleware.ts#default': async (api, _served, ran) => (ran(), api.default({ method: 'GET', headers: {} })),

  // Null is "allow" on both of these.
  'guard.ts#inspectServerFn': async (api, _served, ran) => (ran(), api.inspectServerFn({ any: 'args' })),
  'guard.ts#guardRequest': async (api, _served, ran) => (ran(), api.guardRequest(REQUEST())),
  // The response goes out as it came in.
  'guard.ts#screenResponse': async (api, served, ran) => (ran(), api.screenResponse(served)),
};

/**
 * The one seam that cannot step aside, stated here so it is a decision rather than an omission.
 *
 * On that path the guard IS the handler — it forwards the browser's tunnelled Supabase calls — so there
 * is no app handler to delegate to, and a protection is what makes it able to answer at all.
 */
const NOWHERE_TO_DELEGATE = 'guard.ts#handleGuardRequest';

/**
 * Which exported seams of a template reach for a protection.
 *
 * Read from the source rather than listed by hand: an export added to an existing template shows up as
 * a pair with no case for it.
 */
function seamsIn(source: string): string[] {
  const seams = new Set<string>();
  let current: string | null = null;
  for (const line of source.split('\n')) {
    const named = /^(?:export )?(?:async )?function (\w+)/.exec(line) ?? /^export const (\w+)/.exec(line);
    if (named) current = named[1];
    else if (/^export default/.test(line)) current = 'default';
    if (/getProtection\(/.test(line) && current && current !== 'getProtection') seams.add(current);
  }

  return [...seams];
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__psAttempts;
  vi.restoreAllMocks();
});

/**
 * The template as an app receives it, with the imports an app resolves redirected: the published
 * package, the rules file beside it, and h3 for the Nitro seam.
 */
async function seamWith(name: string, factory = REJECTS): Promise<Record<string, any>> {
  const commonjs = name.endsWith('.cjs');
  const dir = mkdtempSync(join(tmpdir(), 'ps-seam-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: commonjs ? 'commonjs' : 'module' }));

  writeFileSync(
    join(dir, commonjs ? 'stub.cjs' : 'stub.mjs'),
    commonjs
      ? `module.exports = { createProtection: ${factory}, createSupabaseGuard: () => {}, createServerFnGuard: () => {}, GUARD_PATH: "/x", sentinelAnswer: async () => null, VERIFY_HEADER: "x-patchstack-verify" };\n`
      : `export const createProtection = ${factory};\nexport const createSupabaseGuard = () => {};\nexport const createServerFnGuard = () => {};\nexport const GUARD_PATH = "/x";\nexport const sentinelAnswer = async () => null;\nexport const VERIFY_HEADER = "x-patchstack-verify";\n`,
  );
  // The runtime templates READ the file beside them; the TypeScript ones IMPORT it, and a JSON import
  // needs an attribute Node would demand of the compiled output. So both are provided.
  writeFileSync(join(dir, 'rules.json'), RULES);
  writeFileSync(join(dir, 'rules-stub.mjs'), `export default ${RULES};\n`);
  writeFileSync(
    join(dir, 'h3-stub.mjs'),
    'export const defineEventHandler = (fn) => fn;\n' +
      'export const getRequestURL = () => new URL("https://app.example.com/x");\n' +
      'export const readRawBody = async () => undefined;\n' +
      'export const setResponseStatus = () => {};\n' +
      'export const setResponseHeader = () => {};\n',
  );

  let source = readFileSync(new URL(name, TEMPLATE_DIR), 'utf8')
    .replace('"@patchstack/connect/protect"', JSON.stringify(`./${commonjs ? 'stub.cjs' : 'stub.mjs'}`))
    .replace(/from "\.\/(?:patchstack\.)?rules\.json"/, 'from "./rules-stub.mjs"')
    .replace('"h3"', '"./h3-stub.mjs"');
  let file = join(dir, name);
  if (name.endsWith('.ts')) {
    // The app compiles its own TypeScript; here esbuild does, since the subject is the seam's behaviour
    // and not the toolchain that gets it there.
    source = transformSync(source, { loader: 'ts', format: 'esm' }).code;
    file = join(dir, `${name.slice(0, -3)}.mjs`);
  }
  writeFileSync(file, source);

  const loaded: any = await import(pathToFileURL(file).href);

  return loaded.default && commonjs ? loaded.default : loaded;
}

describe('a seam that cannot get a protection', () => {
  it('has a case for every seam in every template, or a stated reason', () => {
    const pairs = readdirSync(new URL(TEMPLATE_DIR))
      .filter((name) => /\.(?:ts|js|cjs)$/.test(name))
      .flatMap((name) =>
        seamsIn(readFileSync(new URL(name, TEMPLATE_DIR), 'utf8')).map((seam) => `${name}#${seam}`),
      );

    expect(pairs.sort()).toEqual([...Object.keys(SEAMS), NOWHERE_TO_DELEGATE].sort());
  });

  for (const [pair, drive] of Object.entries(SEAMS)) {
    it(`${pair}: the app answers, once`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const served = new Response('the app answered', { status: 200 });
      let ran = 0;

      const api = await seamWith(pair.split('#')[0]);
      const answer: any = await drive(api, served, () => {
        ran += 1;
      });

      expect(ran, "the app's own work happened exactly once").toBe(1);
      if (answer instanceof Response) expect(await answer.text()).toBe('the app answered');
      else expect(answer ?? null).toBeNull();

      expect(warn.mock.calls.flat().join(' '), 'and it says traffic may go unscreened').toContain(
        'protection is unavailable',
      );
    });
  }

  it(`${NOWHERE_TO_DELEGATE}: fails the call, because the guard is the handler there`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = await seamWith('guard.ts');

    // Stated as behaviour rather than left unasserted: this seam forwards the browser's tunnelled calls
    // itself, so without a protection there is no app handler to fall back to.
    await expect(api.handleGuardRequest(REQUEST())).rejects.toThrow('no protection here');
  });
});

describe('a Node middleware whose guard fails after the request was passed on', () => {
  const NODE_SEAMS = Object.keys(SEAMS).filter((pair) => pair.endsWith('#patchstackMiddleware'));

  it('covers both middleware templates in each module format', () => {
    expect(NODE_SEAMS).toHaveLength(6);
  });

  for (const pair of NODE_SEAMS) {
    it(`${pair}: passes it on once, not twice`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let passedOn = 0;

      const api = await seamWith(pair.split('#')[0], FAILS_AFTER_PASSING_ON);
      api.patchstackMiddleware(NODE_REQUEST, {}, () => {
        passedOn += 1;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(passedOn, 'the app continues exactly once').toBe(1);
      expect(warn.mock.calls.flat().join(' ')).toContain('after the app');
    });
  }
});

describe('a build that failed is tried again', () => {
  it('asks once per request, reports once, and screens as soon as a build succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = await seamWith('generic-guard.js', RECOVERS_AFTER(2));
    const app = async () => new Response('the app answered', { status: 200 });

    const first = (await api.protectFetch(app)(REQUEST())) as Response;
    const second = (await api.protectFetch(app)(REQUEST())) as Response;

    expect(await first.text(), 'unscreened while no protection can be built').toBe('the app answered');
    expect(await second.text()).toBe('the app answered');
    // Two requests, two attempts: a failed build is not cached, so the next request is a fresh try.
    expect(attempts(), 'each request tried again').toBe(2);
    // One line for two failures, and they had different causes.
    expect(warn, 'only the first failure is reported').toHaveBeenCalledTimes(1);

    const third = (await api.protectFetch(app)(REQUEST())) as Response;

    expect(third.status, 'screening resumes on the build that succeeds').toBe(403);
    expect(attempts()).toBe(3);
  });
});

describe('a Fastify plugin', () => {
  it('builds at registration, before any request arrives', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = await seamWith('fastify-plugin.js', RECOVERS_AFTER(0));

    await api.patchstackFastify({ addHook: () => {} });

    // Building the protection is what installs egress screening, and an app makes outbound calls while
    // it starts up — before any request exists to build on.
    expect(attempts(), 'registration built it').toBe(1);
  });

  it('retries on a request when the build at registration failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = await seamWith('fastify-plugin.js', RECOVERS_AFTER(1));
    const sent: unknown[] = [];

    await throughFastifyHooks(api, { code: () => {}, header: () => {}, send: (body: unknown) => sent.push(body) });

    // Two attempts: the failed one at registration, and the hook's own — which is what screened.
    expect(attempts()).toBe(2);
    expect(sent, 'the retried build screens the request').toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
