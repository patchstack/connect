// What `protect --check --runtime` is allowed to launch.
//
// One rule decides everything here: the verifier runs `node <file>` on a file this project already has,
// and nothing else. It does not run package scripts through a package manager, does not run a binary out
// of `node_modules/.bin`, does not build, and does not install. A verification command that installs or
// builds is a verification command that changes the thing it is verifying — and on an unfamiliar repo it
// is arbitrary code execution dressed as a check.
//
// The cost of that rule is that TypeScript entries, framework dev servers and monorepo launchers come
// back unavailable rather than verified. That is the honest answer: those entries cannot be started
// without the project's own toolchain, and a check that guesses at one would report on something the app
// never runs.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { CODE_LOADING_FLAGS, NO_OPERAND_FLAGS, VALUED_FLAGS, flagName } from '../node-flags.js';

export type EntryResolution =
  | {
      kind: 'entry';
      file: string;
      /** Node flags from the project's own start script. */
      nodeArgs: string[];
      /** Arguments the start script passes to the app itself. */
      appArgs: string[];
      /** Where the entry came from, for the line the CLI prints. */
      from: string;
    }
  | { kind: 'unavailable'; reason: string };

/** Files a project conventionally starts, in the order a reader would try them. */
const CONVENTIONAL = [
  'server.js', 'server.mjs', 'server.cjs',
  'app.js', 'app.mjs', 'app.cjs',
  'index.js', 'index.mjs', 'index.cjs',
  'src/server.js', 'src/server.mjs', 'src/server.cjs',
  'src/index.js', 'src/index.mjs', 'src/index.cjs',
  'dist/server.js', 'dist/index.js', 'dist/main.js',
  'build/index.js', 'build/server.js',
];

/** Node loads these directly. `.ts` and `.tsx` need the project's own loader, whatever it is. */
const LOADABLE = /\.(?:js|mjs|cjs)$/;

function readPackage(cwd: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));

    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Inside `cwd`, and a file Node can load on its own. Nothing else is launchable.
 *
 * Containment is checked on the REAL paths of both sides, not the written ones. Two things would slip
 * past a comparison of path text: a project at `/srv/app` accepting `/srv/app-staging/server.js`, which
 * a bare prefix test allows, and a `server.js` inside the project that is a symlink to a file outside
 * it — `resolve` normalises text and never looks at the filesystem, while the thing that would actually
 * be executed is the link's target.
 */
function loadable(cwd: string, candidate: string): string | null {
  const written = resolve(cwd, candidate);
  if (!LOADABLE.test(written) || !isFile(written)) return null;

  let root: string;
  let path: string;
  try {
    root = realpathSync(cwd);
    path = realpathSync(written);
  } catch {
    return null; // a path that cannot be resolved is not a path this will run
  }
  if (path !== root && !path.startsWith(root + sep)) return null;

  return written;
}

/**
 * Node flags this understands well enough to pass on, deliberately few.
 *
 * The grammar is the problem, not the flags. A start script is written for a shell and for Node's own
 * argument parser, and this reads it with neither: it splits on whitespace. So the only tokens accepted
 * are ones whose meaning cannot depend on what follows them — one of the operand-free flags, or a
 * self-contained `--name=value` whose name is on the valued allowlist. Every other flag is refused,
 * an unrecognised `--name=value` included: a flag that takes its operand as the NEXT token turns the
 * token after it into a flag value, and `--eval=…` and `--print=…` take the program out of the file
 * named on the command line altogether. Reading either as the entry would launch a different program
 * than the script describes.
 *
 * The inventory itself lives in `../node-flags.js`, shared with the probe and the structural parse.
 */
function passable(token: string): boolean {
  if (CODE_LOADING_FLAGS.has(flagName(token))) return false;
  if (NO_OPERAND_FLAGS.has(token)) return true;

  return token.includes('=') && VALUED_FLAGS.has(flagName(token));
}

/**
 * A start script this may run itself, which means: the word `node`, flags from the bounded set above, a
 * file it can load — and, after that, whatever arguments the project passes its own app.
 *
 * Anything else is somebody else's program, or a program this cannot read with confidence. `next start`
 * needs Next, `tsx server.ts` and `node server.ts` need a loader, `bun server.js` and `nodemon
 * server.js` are not this runtime, `cross-env NODE_ENV=x node .` needs cross-env, and `npm run build &&
 * node .` builds first. Quoting, `$VARIABLE`, globs and `--` are refused for a plainer reason: they mean
 * something to the shell that runs the real script and nothing to the whitespace split done here, so a
 * script containing them is not a script this can claim to have reproduced.
 *
 * Nothing here reaches a shell — the launch is an argument array, so a metacharacter is a misreading
 * risk rather than an injection one — but reading a script wrongly is exactly how a verification ends up
 * reporting on a program nobody runs.
 */
function fromScript(cwd: string, script: string): { file: string; nodeArgs: string[]; appArgs: string[] } | null {
  // This is not a shell parser. Refuse every shell form that can change the words the argument-array
  // launch receives: operators and comments, quoting and escapes, substitutions, glob forms, tilde
  // expansion, and a newline that starts another command. Spaces and tabs remain the only separators.
  if (/[&|;><()#$`'"*?\[\]{}\\~\r\n]/.test(script)) return null;
  const parts = script.trim().split(/\s+/);
  if (parts[0] !== 'node') return null;

  const nodeArgs: string[] = [];
  let rest = parts.slice(1);
  while (rest.length > 0 && rest[0]!.startsWith('-')) {
    const token = rest[0]!;
    if (!passable(token)) return null;
    nodeArgs.push(token);
    rest = rest.slice(1);
  }
  if (rest.length === 0) return null; // `node` with no file: a REPL, not an app

  const file = loadable(cwd, rest[0]!);

  return file === null ? null : { file, nodeArgs, appArgs: rest.slice(1) };
}

/**
 * The file the runtime check will start, or why it will not start anything.
 *
 * Order: a start script that is a plain `node` invocation, then `package.json` `main`, then the
 * conventional entries. The script comes first because it is the project SAYING what it runs; the rest
 * are inference, and inference that lands on the wrong file would verify a program nobody serves.
 */
export function resolveEntry(cwd: string): EntryResolution {
  const pkg = readPackage(cwd);
  const scripts = (pkg?.scripts ?? null) as Record<string, unknown> | null;

  // A declared script is the end of the search either way: where the project says what it runs, a
  // fallback to some other file would verify a program nobody serves.
  const declared = ['start', 'serve']
    .map((name) => ({ name, script: scripts?.[name] }))
    .find((entry): entry is { name: string; script: string } => typeof entry.script === 'string' && entry.script.trim() !== '');

  if (declared !== undefined) {
    const resolved = fromScript(cwd, declared.script);

    return resolved === null
      ? {
          kind: 'unavailable',
          reason: `the "${declared.name}" script is outside the bounded \`node <file>\` form this check can launch without the project's own toolchain`,
        }
      : { kind: 'entry', ...resolved, from: `the "${declared.name}" script` };
  }

  const main = pkg?.main;
  if (typeof main === 'string') {
    const file = loadable(cwd, main);
    if (file !== null) return { kind: 'entry', file, nodeArgs: [], appArgs: [], from: 'the package "main" field' };
  }

  for (const candidate of CONVENTIONAL) {
    const file = loadable(cwd, candidate);
    if (file !== null) return { kind: 'entry', file, nodeArgs: [], appArgs: [], from: candidate };
  }

  return {
    kind: 'unavailable',
    reason: existsSync(join(cwd, 'package.json'))
      ? 'no directly loadable entry was found — declare one as a "start" script of the form `node <file>`, or run the check against a built output'
      : 'there is no package.json here',
  };
}
