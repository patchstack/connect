#!/usr/bin/env node
// Does the PUBLISHED package work when a real consumer installs it?
//
// Everything else in this repository tests the source, or at best `dist/` from inside the repository. That
// cannot see the questions a consumer actually hits, because they are all decided by the tarball's
// metadata rather than by the code: which file an `exports` condition resolves to, which declarations
// TypeScript reads beside it, whether `files` left something out, whether the bin is executable.
//
// Such failures are invisible from inside the repository and total for the consumer: the source suite is
// green while nothing can import the package. Each shape below states the consumption path it holds open.
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
const WINDOWS = process.platform === 'win32';

/** Quote one argument for the Windows interpreter: wrap it, and double any `"`, which is cmd's escape. */
const quoteArg = (token) => `"${String(token).replace(/"/g, '""')}"`;

/**
 * The command word, quoted only when it is a path.
 *
 * A BARE name must stay unquoted. `npm` on Windows is `npm.cmd`, found through `PATH` and `PATHEXT`, and
 * the shim resolves its own installation with `%~dp0` — the directory of the batch file it is running.
 * Quoting the name changes how cmd resolves it, `%~dp0` becomes the working directory, and npm then looks
 * for its own CLI under whatever project happens to be current.
 *
 * An ABSOLUTE path must be quoted: the binaries in `node_modules/.bin` are addressed by path, and a
 * Windows temp or workspace path contains spaces.
 */
const quoteCommand = (cmd) => (path.isAbsolute(cmd) ? quoteArg(cmd) : cmd);

/**
 * Run a tool and return its stdout.
 *
 * On Windows the package managers and installed binaries are `.cmd` shims. `execFileSync` creates a process
 * directly and a batch file is not an executable image, so it cannot launch one — the interpreter has to be
 * invoked explicitly. Every other platform executes directly: no shell, nothing to quote, nothing to escape
 * wrongly.
 *
 * The Windows form is `cmd /d /s /c "<line>"` with `windowsVerbatimArguments`, which is the only
 * combination that behaves predictably: `/s` makes cmd strip exactly the outermost quote pair and take the
 * rest verbatim, and `windowsVerbatimArguments` stops Node re-escaping the line first. Without both, the
 * quotes around individual arguments are rewritten and a path with a space breaks.
 *
 * See https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows.
 */
function run(cmd, args, cwd, extraEnv = {}) {
  const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } };

  if (!WINDOWS) return execFileSync(cmd, args, options);

  const line = [quoteCommand(cmd), ...args.map(quoteArg)].join(' ');

  return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

/** Install a local tarball. Each manager spells it differently, and their resolution differs — which is
 *  the point of running all four rather than assuming npm's answer generalises. */
const INSTALL = {
  npm: (tgz, deps) => ['npm', ['install', '--no-audit', '--no-fund', '--silent', tgz, ...deps]],
  pnpm: (tgz, deps) => ['pnpm', ['add', '--silent', tgz, ...deps]],
  yarn: (tgz, deps) => ['yarn', ['add', tgz, ...deps]],
  bun: (tgz, deps) => ['bun', ['add', tgz, ...deps]],
};

/**
 * What a fixture needs before its manager will treat it as its own project, and resolve the way a
 * consumer of this package does.
 *
 * Two things for Yarn, and both are stated rather than left to a default:
 *
 * `yarn.lock` — Berry walks up from the working directory looking for a project root and adopts any
 * `package.json` above it, which a temp directory usually has. An empty lockfile declares the fixture
 * self-contained, which is Berry's own documented answer. Harmless under Classic, which writes one anyway.
 *
 * `nodeLinker: node-modules` — this is the layout being tested, so it is pinned instead of inherited.
 * Berry's linker otherwise depends on its version and on any `.yarnrc.yml` above the fixture, so the same
 * script resolves differently on two machines, and a pass says nothing about which layout was exercised.
 * Under Plug'n'Play nothing is in `node_modules` at all and a plain `node probe.mjs` cannot resolve the
 * package — a real Berry configuration, and a separate shape this matrix does not cover.
 */
const PREPARE = {
  yarn: (dir) => {
    writeFileSync(path.join(dir, 'yarn.lock'), '');
    writeFileSync(path.join(dir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
  },
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
 * `cjs-ts-no-node-types` is not redundant with `cjs-ts`: every other TypeScript fixture installs
 * `@types/node`, so it is the only one that holds the public declarations free of it.
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
      // The positive control comes first and is not optional: every other assertion here expects an import
      // to FAIL, so without it the case passes when the package is absent entirely.
      'probe.mjs': [
        "const root = await import('@patchstack/connect');",
        "if (typeof root.buildWirePayload !== 'function') {",
        "  throw new Error('control failed: the public root does not resolve, so nothing below proves encapsulation');",
        '}',
        '',
        'const leaked = [];',
        "for (const subpath of ['@patchstack/connect/dist/cli.js', '@patchstack/connect/package.json', '@patchstack/connect/src/index.ts']) {",
        '  try {',
        '    await import(subpath);',
        '    leaked.push(subpath);',
        "  } catch { /* expected: not named in `exports` */ }",
        '}',
        "if (leaked.length) throw new Error('reachable outside exports: ' + leaked.join(', '));",
        '',
      ].join('\n'),
    },
    check: (dir) => run('node', ['probe.mjs'], dir),
  },
];

// A local binary is addressed by path, so on Windows it needs the shim's extension spelled out.
const localBin = (dir, name) => path.join(dir, 'node_modules', '.bin', WINDOWS ? `${name}.cmd` : name);
const tsc = (dir) => localBin(dir, 'tsc');
const bin = (dir) => localBin(dir, 'patchstack-connect');

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

  // Which manager, at which version. The label alone says "Yarn", and Classic and Berry resolve
  // differently enough that a pass under one is not a pass under the other.
  let managerVersion = 'unknown';
  try {
    managerVersion = run(manager, ['--version'], ROOT).trim().split('\n').pop();
  } catch { /* the install below fails loudly if the manager is missing */ }

  console.log(`packed ${path.basename(tarball)}`);
  console.log(`node ${process.version} · ${manager} ${managerVersion} · ${process.platform}\n`);

  for (const shape of SHAPES) {
    const dir = path.join(work, shape.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `consumer-${shape.name}`, private: true, ...shape.pkg }, null, 2));
    for (const [file, body] of Object.entries(shape.files ?? {})) writeFileSync(path.join(dir, file), body);

    try {
      PREPARE[manager]?.(dir);
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
