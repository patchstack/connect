#!/usr/bin/env node
// Does the PUBLISHED package work when a real consumer installs it?
//
// Everything else in this repository tests the source, or at best `dist/` from inside the repository. That
// cannot see the questions a consumer actually hits, because they are all decided by the tarball's
// metadata rather than by the code: which file an `exports` condition resolves to, which declarations
// TypeScript reads beside it, whether `files` left something out, whether the bin is executable.
//
// Those failures are invisible from here and total for the consumer. Two were shipped and found by writing
// this:
//
//   - `exports` had a single top-level `types` pointing at the ESM declarations, so a CommonJS TypeScript
//     consumer resolved `require` for the runtime and ESM types for the shape. TypeScript concluded the
//     target was an ES module and refused the `require` (TS1479) — while CommonJS JavaScript worked. The
//     package was unusable from CommonJS TypeScript.
//   - the published declarations referenced `NodeJS.ProcessEnv`, from `@types/node`, which this package
//     does not depend on. A consumer without it could not compile against the types at all.
//
// Run: node scripts/compat-matrix.mjs [--manager npm|pnpm|yarn|bun]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const manager = (() => {
  const i = process.argv.indexOf('--manager');
  return i === -1 ? 'npm' : process.argv[i + 1];
})();

const ROOT = process.cwd();
const run = (cmd, args, cwd, extraEnv = {}) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });

/** Install a local tarball. Each manager spells it differently, and their resolution differs — which is
 *  the point of running all four rather than assuming npm's answer generalises. */
const INSTALL = {
  npm: (tgz, deps) => ['npm', ['install', '--no-audit', '--no-fund', '--silent', tgz, ...deps]],
  pnpm: (tgz, deps) => ['pnpm', ['add', '--silent', tgz, ...deps]],
  yarn: (tgz, deps) => ['yarn', ['add', tgz, ...deps]],
  bun: (tgz, deps) => ['bun', ['add', tgz, ...deps]],
};

if (!INSTALL[manager]) {
  console.error(`Unknown manager: ${manager}. Known: ${Object.keys(INSTALL).join(', ')}`);
  process.exit(2);
}

const PROBE_TS = `
import { buildWirePayload, collectHostingEnvKeys } from '@patchstack/connect';
import { createProtection } from '@patchstack/connect/protect';
void buildWirePayload({ ecosystem: 'npm', packages: [] });
void collectHostingEnvKeys({ VERCEL: '1' });
void createProtection;
`;

const TSCONFIG = (module_, resolution, types) => JSON.stringify({
  compilerOptions: {
    module: module_, moduleResolution: resolution, target: 'es2022',
    strict: true, noEmit: true, ...(types ? { types } : {}),
  },
}, null, 2);

/**
 * Each consumer shape, and what it is here to prove.
 *
 * `cjs-ts-no-node-types` is not redundant with `cjs-ts`: it is the only one that catches published
 * declarations depending on `@types/node` without declaring it, because every other fixture installs it.
 */
const SHAPES = [
  {
    name: 'esm-js', why: 'ESM JavaScript import',
    pkg: { type: 'module' }, deps: [],
    files: { 'probe.mjs': "import * as r from '@patchstack/connect';\nimport * as p from '@patchstack/connect/protect';\nif (typeof r.buildWirePayload !== 'function') throw new Error('root export missing');\nif (typeof p.createProtection !== 'function') throw new Error('protect export missing');\n" },
    check: (dir) => run('node', ['probe.mjs'], dir),
  },
  {
    name: 'cjs-js', why: 'CommonJS require',
    pkg: {}, deps: [],
    files: { 'probe.cjs': "const r = require('@patchstack/connect');\nconst p = require('@patchstack/connect/protect');\nif (typeof r.buildWirePayload !== 'function') throw new Error('root export missing');\nif (typeof p.createProtection !== 'function') throw new Error('protect export missing');\n" },
    check: (dir) => run('node', ['probe.cjs'], dir),
  },
  {
    name: 'esm-ts', why: 'ESM TypeScript compilation',
    pkg: { type: 'module' }, deps: ['typescript@5', '@types/node'],
    files: { 'probe.ts': PROBE_TS, 'tsconfig.json': TSCONFIG('nodenext', 'nodenext') },
    check: (dir) => run(tsc(dir), ['-p', 'tsconfig.json'], dir),
  },
  {
    name: 'cjs-ts', why: 'CommonJS TypeScript compilation',
    pkg: {}, deps: ['typescript@5', '@types/node'],
    files: { 'probe.ts': PROBE_TS, 'tsconfig.json': TSCONFIG('node16', 'node16') },
    check: (dir) => run(tsc(dir), ['-p', 'tsconfig.json'], dir),
  },
  {
    name: 'cjs-ts-no-node-types', why: 'published types must not require an undeclared @types/node',
    pkg: {}, deps: ['typescript@5'],
    files: { 'probe.ts': PROBE_TS, 'tsconfig.json': TSCONFIG('node16', 'node16', []) },
    check: (dir) => run(tsc(dir), ['-p', 'tsconfig.json'], dir),
  },
  {
    name: 'cli', why: 'the installed bin runs',
    pkg: { type: 'module' }, deps: [],
    check: (dir) => {
      const out = run(bin(dir), ['--help'], dir);
      if (!out.includes('patchstack-connect')) throw new Error(`bin produced no recognisable help:\n${out}`);

      return out;
    },
  },
  {
    name: 'encapsulation', why: 'nothing outside exports is reachable',
    pkg: { type: 'module' }, deps: [],
    files: {
      'probe.mjs': "let leaked = [];\nfor (const p of ['@patchstack/connect/dist/cli.js', '@patchstack/connect/package.json', '@patchstack/connect/src/index.ts']) {\n  try { await import(p); leaked.push(p); } catch {}\n}\nif (leaked.length) throw new Error('reachable outside exports: ' + leaked.join(', '));\n",
    },
    check: (dir) => run('node', ['probe.mjs'], dir),
  },
];

const tsc = (dir) => path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const bin = (dir) => path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'patchstack-connect.cmd' : 'patchstack-connect');

/** Pack the real artifact. `--ignore-scripts` is deliberately NOT passed: `prepare` builds `dist/`. */
function packTarball(into) {
  const out = run('npm', ['pack', '--pack-destination', into, '--silent'], ROOT).trim().split('\n').pop().trim();
  // npm's stdout has carried extra lines across versions, so trust the directory rather than the parse.
  const found = readdirSync(into).filter((f) => f.endsWith('.tgz'));
  if (found.length !== 1) throw new Error(`expected exactly one tarball in ${into}, found: ${found.join(', ') || 'none'} (npm said "${out}")`);

  return path.join(into, found[0]);
}

const work = mkdtempSync(path.join(tmpdir(), 'ps-compat-'));
let failures = 0;

try {
  const tarball = packTarball(work);
  console.log(`packed ${path.basename(tarball)}; installing with ${manager}\n`);

  for (const shape of SHAPES) {
    const dir = path.join(work, shape.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `consumer-${shape.name}`, private: true, ...shape.pkg }, null, 2));
    for (const [file, body] of Object.entries(shape.files ?? {})) writeFileSync(path.join(dir, file), body);

    try {
      const [cmd, args] = INSTALL[manager](tarball, shape.deps);
      run(cmd, args, dir);
      shape.check(dir);
      console.log(`  ok    ${shape.name.padEnd(22)} ${shape.why}`);
    } catch (error) {
      failures++;
      const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message;
      console.log(`  FAIL  ${shape.name.padEnd(22)} ${shape.why}`);
      console.log(detail.split('\n').slice(0, 8).map((l) => `          ${l}`).join('\n'));
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0
  ? `\nall ${SHAPES.length} consumer shapes work with ${manager}`
  : `\n${failures} of ${SHAPES.length} consumer shapes FAILED with ${manager}`);
process.exit(failures === 0 ? 0 : 1);
