// Locate the source file + variable where an app instance is created, for the register-into-app
// adapters (Express/Fastify/NestJS). Dependency-free: walk src/ (or the repo root) for a source
// file matching `re`, which MUST capture the app variable name in group 1.

import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

// Build/output/test dirs are skipped so we never patch a COMPILED artifact (e.g. dist/main.js) —
// which would leave the real src/ entry unprotected and vary by machine.
const SKIP_DIRS = new Set([
  'node_modules', 'patchstack', 'dist', 'build', 'out', 'coverage', '.next', '.output', '.svelte-kit',
  'test', 'tests', '__tests__', 'e2e', 'examples', 'fixtures', '__fixtures__',
]);
const MAX_DEPTH = 8;

export interface AppInstance {
  relPath: string;
  appVar: string;
  /** Other files that create a server of their own and listen on it. Each needs its own guard. */
  others: string[];
}

/**
 * The app instance to wire, plus any OTHER server this project starts.
 *
 * A project can have more than one server — an API and an admin app, a worker with its own port. Taking the
 * first file in alphabetical order picks one of them for reasons that have nothing to do with which one
 * serves the traffic, and wires it while reporting the project protected. So every match is collected: the
 * one that looks most like the main entry is wired, and the rest are named, because a guard on one server
 * is not a guard on the other.
 *
 * "Another server" means a file that both creates an instance and listens on it. An instance created and
 * handed back to a caller is a plugin or a factory, and is served through whichever app mounts it.
 */
export function findAppInstance(cwd: string, re: RegExp): AppInstance | null {
  const root = existsSync(join(cwd, 'src')) ? join(cwd, 'src') : cwd;
  const found: Array<{ relPath: string; appVar: string; listens: boolean }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort(); // deterministic order across machines
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const p = join(dir, name);
      let st;
      try {
        st = lstatSync(p); // lstat, not stat — do NOT follow symlinks (avoids symlink-cycle recursion)
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/\.(?:ts|js|mjs|cjs)$/.test(name)) {
        let src: string;
        try {
          src = readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        const m = re.exec(src);
        if (!m) continue;
        const appVar = m[1]!;
        found.push({
          relPath: relative(cwd, p).replace(/\\/g, '/'),
          appVar,
          listens: listensOn(src, appVar),
        });
      }
    }
  };
  walk(root, 0);
  if (found.length === 0) return null;

  const declared = declaredEntries(cwd);
  const chosen = found
    .slice()
    .sort((a, b) => rankEntry({ ...a, declared: declared.has(a.relPath) }, { ...b, declared: declared.has(b.relPath) }))[0]!;

  return {
    relPath: chosen.relPath,
    appVar: chosen.appVar,
    others: found.filter((f) => f !== chosen && f.listens).map((f) => f.relPath),
  };
}

/** Does this file start a server on `appVar`, or only build one for somebody else to mount? */
function listensOn(source: string, appVar: string): boolean {
  return new RegExp(`\\b${appVar}\\s*\\.\\s*listen\\s*\\(`).test(source);
}

/** Basenames that conventionally name a server entry, best first. */
const ENTRY_NAMES = ['server', 'index', 'main', 'app'];

/**
 * Most-likely main entry first: the file the package itself names, then one that listens, then a
 * conventional entry name, then the shallowest path, then alphabetical.
 *
 * Alphabetical last only so the choice does not vary between machines — on its own it is not a reason to
 * prefer one server over another, which is why the ones not chosen are reported rather than dropped.
 */
function rankEntry(
  a: { relPath: string; listens: boolean; declared: boolean },
  b: { relPath: string; listens: boolean; declared: boolean },
): number {
  if (a.declared !== b.declared) return a.declared ? -1 : 1;
  if (a.listens !== b.listens) return a.listens ? -1 : 1;
  const named = entryRank(a.relPath) - entryRank(b.relPath);
  if (named !== 0) return named;
  const depth = a.relPath.split('/').length - b.relPath.split('/').length;
  if (depth !== 0) return depth;

  return a.relPath < b.relPath ? -1 : 1;
}

function entryRank(relPath: string): number {
  const base = (relPath.split('/').pop() ?? '').replace(/\.(?:ts|js|mjs|cjs)$/, '');
  const index = ENTRY_NAMES.indexOf(base);

  return index === -1 ? ENTRY_NAMES.length : index;
}

/**
 * Files the package points at itself — `main`, `module`, and any file named by a start or dev script.
 *
 * The project's own answer to which file is the entry, and better than any guess made from the name.
 */
function declaredEntries(cwd: string): Set<string> {
  const paths = new Set<string>();
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  } catch {
    return paths;
  }

  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    for (const match of value.matchAll(/[\w./@-]+\.(?:ts|js|mjs|cjs)/g)) {
      paths.add(match[0].replace(/^\.\//, ''));
    }
  };

  add(pkg.main);
  add(pkg.module);
  const scripts = pkg.scripts;
  if (typeof scripts === 'object' && scripts !== null) {
    for (const name of ['start', 'serve', 'dev']) add((scripts as Record<string, unknown>)[name]);
  }

  return paths;
}

/** Relative ESM specifier from `fromRel` to `toRel` (both repo-relative, extension stripped). */
export function importSpecifier(fromRel: string, toRel: string, preserveExtension = false): string {
  let spec = relative(dirname(fromRel), toRel).replace(/\\/g, '/');
  if (!preserveExtension) spec = spec.replace(/\.(?:ts|js)$/, '');
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return spec;
}
