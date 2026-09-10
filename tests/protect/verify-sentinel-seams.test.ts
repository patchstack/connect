import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { VERIFY_HEADER } from '../../src/protect/verify-sentinel.js';
// The value the harness will compare against, computed its way (node crypto) rather than the seam's
// (web crypto). Asserting the seam against the OTHER implementation is what makes the two agree.
import { expectedAnswerFor } from '../../src/protect/install/runtime/probe.js';

/**
 * Every seam a scaffolded guard exposes, asked whether a verification request reaches it.
 *
 * Per (template, SEAM) rather than per file: a template can expose more than one, and the generic guard
 * exposes two — a fetch handler and a Node middleware. A file-level case would prove one and imply the
 * other.
 *
 * Two things are asserted for each. The seam answers with the value derived from the challenge, which is
 * what a run distinguishes from an app answering by accident. And the app's own handler is not called: a
 * seam that answered after passing the request on would report traversal for a request the application
 * had already handled.
 */
const TEMPLATE_DIR = new URL('../../src/protect/templates/', import.meta.url);
const CHALLENGE = 'e'.repeat(64);
const RULES = JSON.stringify({ firewall: [], whitelists: [] });

type Drive = (api: Record<string, any>, ranHandler: () => void) => Promise<string | null>;

/** The fetch seam: what it answers is a Response body. */
const fetchSeam: Drive = async (api, ranHandler) => {
  const handler = async () => {
    ranHandler();

    return new Response('the app answered', { status: 200 });
  };
  const answer: any = await api.protectFetch(handler)(
    new Request('https://app.example.com/', { headers: { [VERIFY_HEADER]: CHALLENGE } }),
  );

  return answer instanceof Response ? (await answer.text()).trim() : null;
};

/** The Node/Express seam: what it answers is written to the response, and `next` is the app's turn. */
const nodeSeam: Drive = async (api, ranHandler) =>
  new Promise((resolve) => {
    const chunks: string[] = [];
    const res = {
      statusCode: 0,
      setHeader: () => {},
      end: (body?: string) => {
        if (body) chunks.push(body);
        resolve(chunks.join('').trim() || null);
      },
    };
    api.patchstackMiddleware({ method: 'GET', url: '/', headers: { [VERIFY_HEADER]: CHALLENGE } }, res, () => {
      ranHandler();
      resolve(null);
    });
    setTimeout(() => resolve(null), 300);
  });

/** The Fastify seam: the hook answers through the reply, and reaching the route is the app's turn. */
const fastifySeam: Drive = async (api, ranHandler) => {
  const hooks: Array<(request: unknown, reply: unknown) => unknown> = [];
  await api.patchstackFastify({ addHook: (_event: string, hook: never) => hooks.push(hook) });
  let sent: string | null = null;
  for (const hook of hooks) {
    await hook(
      { method: 'GET', url: '/', headers: { host: 'app.example.com', [VERIFY_HEADER]: CHALLENGE } },
      {
        code: () => {},
        header: () => {},
        send: (body: unknown) => {
          sent = String(body).trim();
        },
      },
    );
  }
  if (sent === null) ranHandler();

  return sent;
};

const SEAMS: Record<string, Drive> = {
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
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * The template as an app receives it, with the package redirected to a stub that carries the REAL
 * sentinel — the thing under test — and a protection that would screen if it were ever asked to.
 */
async function seamWith(name: string): Promise<Record<string, any>> {
  const commonjs = name.endsWith('.cjs');
  const dir = mkdtempSync(join(tmpdir(), 'ps-sentinel-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: commonjs ? 'commonjs' : 'module' }));

  // `fileURLToPath`, not `.pathname`: a path with a space in it stays percent-encoded there, and the
  // module then cannot be found.
  const sentinelUrl = new URL('../../src/protect/verify-sentinel.js', import.meta.url).href;
  const sentinelPath = fileURLToPath(sentinelUrl);
  const stub = commonjs ? 'stub.cjs' : 'stub.mjs';
  // A protection that answers everything, so "the seam answered" cannot be the protection answering.
  const protection =
    '{ express: () => (_req, _res, next) => next(), node: () => (_req, _res, next) => next(),' +
    ' fetchGuard: () => async () => null, screenResponse: async (response) => response }';
  writeFileSync(
    join(dir, stub),
    commonjs
      ? // The sentinel is an ES module, so a CommonJS stub reaches it the way a CommonJS app would have
        // to: dynamically. What matters is that the real one answers, not how the stub gets to it.
        `let real;\n` +
          `const load = async () => (real ??= await import(${JSON.stringify(sentinelUrl)}));\n` +
          `module.exports = {\n` +
          `  createProtection: async () => (${protection}),\n` +
          `  VERIFY_HEADER: "x-patchstack-verify",\n` +
          `  sentinelAnswer: async (offered) => (await load()).sentinelAnswer(offered),\n` +
          `};\n`
      : `export { sentinelAnswer, VERIFY_HEADER } from ${JSON.stringify(sentinelPath)};\n` +
          `export const createProtection = async () => (${protection});\n`,
  );
  writeFileSync(join(dir, 'rules.json'), RULES);
  writeFileSync(join(dir, 'rules-stub.mjs'), `export default ${RULES};\n`);

  let source = readFileSync(new URL(name, TEMPLATE_DIR), 'utf8')
    .replace('"@patchstack/connect/protect"', JSON.stringify(`./${stub}`))
    .replace(/from "\.\/(?:patchstack\.)?rules\.json"/, 'from "./rules-stub.mjs"');
  let file = join(dir, name);
  if (name.endsWith('.ts')) {
    source = transformSync(source, { loader: 'ts', format: 'esm' }).code;
    file = join(dir, `${name.slice(0, -3)}.mjs`);
  }
  writeFileSync(file, source);
  const loaded: any = await import(pathToFileURL(file).href);

  return loaded.default && commonjs ? loaded.default : loaded;
}

describe('a verification request, at every seam a guard exposes', () => {
  it('has a case for every seam in every template that carries the sentinel', () => {
    const pairs = readdirSync(new URL(TEMPLATE_DIR))
      .filter((name) => /^(?:generic-guard|express-guard|fastify-plugin)\.(?:ts|js|cjs)$/.test(name))
      .flatMap((name) => {
        const source = readFileSync(new URL(name, TEMPLATE_DIR), 'utf8');
        // The seams are the exports that answer requests, and the sentinel has to be in each of them.
        return ['protectFetch', 'patchstackMiddleware', 'patchstackFastify']
          .filter((seam) => new RegExp(`function ${seam}\\b`).test(source))
          .map((seam) => `${name}#${seam}`);
      });

    expect(pairs.sort()).toEqual(Object.keys(SEAMS).sort());
    expect(pairs).toHaveLength(12);
  });

  for (const [pair, drive] of Object.entries(SEAMS)) {
    it(`${pair}: answers it, and the app never sees it`, async () => {
      vi.stubEnv('PATCHSTACK_VERIFY_CHALLENGE', CHALLENGE);
      let ranHandler = 0;

      const api = await seamWith(pair.split('#')[0]);
      const answer = await drive(api, () => {
        ranHandler += 1;
      });

      expect(answer, 'the seam answers with the value derived from the challenge').toBe(
        expectedAnswerFor(CHALLENGE),
      );
      expect(ranHandler, "the app's own handler never ran").toBe(0);
    });

    it(`${pair}: is untouched without a challenge`, async () => {
      // The production state: the same request, and the seam does what it always does.
      vi.stubEnv('PATCHSTACK_VERIFY_CHALLENGE', '');
      let ranHandler = 0;

      const api = await seamWith(pair.split('#')[0]);
      const answer = await drive(api, () => {
        ranHandler += 1;
      });

      expect(answer).not.toBe(expectedAnswerFor(CHALLENGE));
      expect(ranHandler, 'the app handled it').toBe(1);
    });
  }
});
