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
// Run: node scripts/compat-matrix.mjs [--manager npm|pnpm|yarn|bun] [--tarball FILE] [--self-contained]
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const manager = (() => {
  const i = process.argv.indexOf('--manager');
  return i === -1 ? 'npm' : process.argv[i + 1];
})();

/**
 * Only the six runtime/package shapes that form the declared-floor contract.
 *
 * For a job pinned to a runtime — the declared consumer floor — the compiler probes are a liability
 * rather than coverage: they install `typescript` and `@types/node` at floating versions, so a floor
 * either of those raises later would turn that job red over something that is not this package. The
 * ordinary consumer matrix still runs all nine shapes on Node 22; only the declared-floor job narrows
 * the set to probes that install nothing but the tarball.
 */
const selfContainedOnly = process.argv.includes('--self-contained');

/**
 * A tarball built elsewhere, or nothing to build one here.
 *
 * Packing runs `prepare`, which needs the repository's development dependencies — and the runtime a
 * consumer is on is not necessarily one those can be installed on. Given a tarball, this script installs
 * and exercises it and touches nothing else, which is what lets a consumer runtime be tested as a
 * consumer runtime.
 */
const prebuilt = (() => {
  const i = process.argv.indexOf('--tarball');
  return i === -1 ? null : path.resolve(process.argv[i + 1]);
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
 * A rule, a request that matches it, and one that does not.
 *
 * Importing the package proves the artifact resolves. It does not prove the guard runs: a build that
 * throws on construction, or screens nothing, imports exactly as well. So this constructs a protection,
 * puts a request through it both ways, and stops it — the smallest thing that fails when the guard is
 * broken rather than merely absent.
 */
const SCREENING_BODY = `
const rules = {
  firewall: [{
    id: 'consumer-probe',
    title: 'a rule the probe supplies itself',
    rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }],
  }],
  whitelists: [],
};

const protection = await createProtection({ rules, mode: 'block' });
try {
  const guard = protection.fetchGuard();
  const blocked = await guard(new Request('https://app.test/search?q=boom'));
  if (!blocked || blocked.status !== 403) throw new Error('a matching rule did not block: ' + (blocked && blocked.status));

  const allowed = await guard(new Request('https://app.test/search?q=hello'));
  if (allowed) throw new Error('a request matching nothing was blocked with ' + allowed.status);
} finally {
  await protection.stop();
}
`;

/**
 * Each consumer shape, and what it is here to prove.
 *
 * `cjs-ts-no-node-types` is not redundant with `cjs-ts`: every other TypeScript fixture installs
 * `@types/node`, so it is the only one that holds the public declarations free of it.
 */
export const SHAPES = [
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
    name: 'esm-js-screens', why: 'the ESM build constructs a guard that blocks and allows',
    pkg: { type: 'module' }, deps: [],
    files: {
      'screen.mjs': `import { createProtection } from '@patchstack/connect/protect';\n${SCREENING_BODY}`,
    },
    check: (dir) => run('node', ['screen.mjs'], dir),
  },
  {
    name: 'cjs-js-screens', why: 'the CommonJS build constructs a guard that blocks and allows',
    pkg: {}, deps: [],
    files: {
      // A separate build from the ESM one above, so it is a separate question.
      'screen.cjs': `const { createProtection } = require('@patchstack/connect/protect');\n(async () => {${SCREENING_BODY}})().catch((err) => {\n  console.error(err);\n  process.exit(1);\n});\n`,
    },
    check: (dir) => run('node', ['screen.cjs'], dir),
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
    name: 'cli', why: 'the installed bin runs and reports its own version',
    pkg: { type: 'module' }, deps: [],
    check: (dir) => {
      const help = run(bin(dir), ['--help'], dir);
      if (!help.includes('patchstack-connect')) throw new Error(`bin produced no recognisable help:\n${help}`);

      // The version a bug report is asked for. It has to come from the manifest npm resolved, so it is
      // checked against the tarball that was just installed rather than against a constant: a build that
      // baked in a stale value, or a manifest left out of `files`, both read as a working `--version`.
      const reported = run(bin(dir), ['--version'], dir).trim();
      const installed = JSON.parse(
        readFileSync(path.join(dir, 'node_modules', '@patchstack', 'connect', 'package.json'), 'utf8'),
      ).version;

      if (reported !== installed) {
        throw new Error(`--version reported "${reported}" but the installed manifest says "${installed}"`);
      }
      if (reported === 'unknown') {
        throw new Error('--version could not read the manifest from the installed package');
      }

      return `${help}\n${reported}`;
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

/**
 * The exact package/runtime probes that must run at the Node version declared in `engines.node`.
 *
 * Explicit names make this a coverage contract rather than a side effect of a fixture's current
 * dependencies. In particular, both published module formats must construct and exercise a guard at
 * the floor; import-only probes cannot stand in for those two behaviours.
 */
export const FLOOR_SHAPE_NAMES = Object.freeze([
  'esm-js',
  'cjs-js',
  'esm-js-screens',
  'cjs-js-screens',
  'cli',
  'encapsulation',
]);

/** Resolve and validate the declared-floor suite before any fixture is installed. */
export function floorShapesOf(shapes) {
  const byName = new Map();

  for (const shape of shapes) {
    if (byName.has(shape.name)) throw new Error(`consumer shape is named more than once: ${shape.name}`);
    byName.set(shape.name, shape);
  }

  const selected = FLOOR_SHAPE_NAMES.map((name) => {
    const shape = byName.get(name);
    if (!shape) throw new Error(`declared-floor consumer shape is missing: ${name}`);
    return shape;
  });

  for (const shape of selected) {
    if (shape.deps.length !== 0) {
      throw new Error(
        `declared-floor consumer shape ${shape.name} must install only the tarball; found: ${shape.deps.join(', ')}`,
      );
    }
  }

  return selected;
}

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

function main() {
  if (!INSTALL[manager]) {
    console.error(`Unknown manager: ${manager}. Known: ${Object.keys(INSTALL).join(', ')}`);
    return 2;
  }

  const shapes = selfContainedOnly ? floorShapesOf(SHAPES) : SHAPES;
  const work = mkdtempSync(path.join(tmpdir(), 'ps-compat-'));
  let failures = 0;

  try {
    // A file, not merely something that exists: an unexpanded glob resolves to a directory, and npm
    // would install that directory as the package — a pass that proves nothing about the artifact.
    if (prebuilt && !(existsSync(prebuilt) && statSync(prebuilt).isFile())) {
      throw new Error(`--tarball needs a packed file; ${prebuilt} is not one`);
    }
    const tarball = prebuilt ?? packTarball(work);

    // Which manager, at which version. The label alone says "Yarn", and Classic and Berry resolve
    // differently enough that a pass under one is not a pass under the other.
    let managerVersion = 'unknown';
    try {
      managerVersion = run(manager, ['--version'], ROOT).trim().split('\n').pop();
    } catch { /* the install below fails loudly if the manager is missing */ }

    console.log(`${prebuilt ? 'given' : 'packed'} ${path.basename(tarball)}`);
    console.log(`node ${process.version} · ${manager} ${managerVersion} · ${process.platform}\n`);

    for (const shape of shapes) {
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
    ? `\nall ${shapes.length} ${selfContainedOnly ? 'declared-floor ' : ''}consumer shapes work with ${manager}`
    : `\n${failures} of ${shapes.length} ${selfContainedOnly ? 'declared-floor ' : ''}consumer shapes FAILED with ${manager}`);
  return failures === 0 ? 0 : 1;
}

function invokedDirectly() {
  const self = realpathSync(fileURLToPath(import.meta.url));

  try {
    return realpathSync(process.argv[1] ?? '') === self;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main();
