// Generic fallback for stacks no built-in adapter matches. Rather than silently skip, we scaffold
// a framework-agnostic guard, print a wiring plan (with best-effort entry-point detection), and
// provide a `--check` verifier — so the builder's own agent can finish the wiring and confirm it,
// entirely through the CLI (no server, no hosted infra).

import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { bakeSiteUuid, read, templatesDir } from './util.js';
import type { WireOptions, VerifyResult } from './types.js';
import { stripComments } from './source-scope.js';

const GUARD_MARKER = 'patchstack/guard';

function genericDir(cwd: string): string {
  return existsSync(join(cwd, 'src')) ? 'src/patchstack' : 'patchstack';
}

export function scaffoldGeneric(
  cwd: string,
  opts: WireOptions,
  guardTemplate = 'generic-guard.ts',
  guardFile = 'guard.ts',
): { changed: string[]; dir: string } {
  const templates = templatesDir();
  const dir = genericDir(cwd);
  const dst = join(cwd, dir);
  mkdirSync(dst, { recursive: true });
  copyFileSync(join(templates, guardTemplate), join(dst, guardFile));
  const guardRel = `${dir}/${guardFile}`;
  const changed = [guardRel];
  if (!opts.demo) bakeSiteUuid(cwd, guardRel);
  const rulesDst = join(dst, 'rules.json');
  if (opts.demo || !existsSync(rulesDst)) {
    copyFileSync(join(templates, opts.demo ? 'demo-rules.json' : 'rules.json'), rulesDst);
    changed.push(`${dir}/rules.json`);
  }
  return { changed, dir };
}

// Best-effort: likely server entry files + whether Express is a dependency.
function candidateEntries(cwd: string): string[] {
  const names = [
    'src/server.ts', 'src/server.js', 'src/index.ts', 'src/index.js', 'src/app.ts', 'src/app.js',
    'src/main.ts', 'server.ts', 'server.js', 'index.ts', 'index.js', 'app.ts', 'app.js',
  ];
  const hits = names.filter((n) => existsSync(join(cwd, n)));
  try {
    const pkg = JSON.parse(read(join(cwd, 'package.json')));
    if (typeof pkg.main === 'string' && existsSync(join(cwd, pkg.main))) hits.push(pkg.main);
  } catch {
    /* ignore */
  }
  return [...new Set(hits)];
}

function usesExpress(cwd: string): boolean {
  try {
    const pkg = JSON.parse(read(join(cwd, 'package.json')));
    return Boolean({ ...pkg.dependencies, ...pkg.devDependencies }.express);
  } catch {
    return false;
  }
}

export function wiringPlan(cwd: string, dir: string): string {
  const entries = candidateEntries(cwd);
  const express = usesExpress(cwd);
  const lines = [
    `no built-in adapter matched this stack — scaffolded a generic guard at ${dir}/guard.ts + ${dir}/rules.json.`,
    'Finish by wiring it into your server (pick the one that fits):',
    `  • Web-Fetch entry:  export default { fetch: protectFetch(yourHandler) }   // import from "${dir}/guard"`,
    `  • Node / Connect:   app.use(patchstackMiddleware)                          // before any body parser`,
    entries.length
      ? `Likely server ${entries.length === 1 ? 'entry' : 'entries'}: ${entries.join(', ')}${express ? '  (Express detected)' : ''}.`
      : 'Could not locate a server entry — wire it wherever requests enter your app.',
    'Then confirm it is hooked up:  npx patchstack-connect protect --check',
  ];
  return lines.join('\n');
}

/** The guard's exports. One of these has to be imported, and the same one has to be called. */
const GUARD_EXPORTS = ['protectFetch', 'patchstackMiddleware', 'screenResponse'] as const;

/**
 * Whether this file imports the guard module and uses what it imported.
 *
 * The import is matched on a real import or require of the guard path, not on the path appearing anywhere —
 * a comment mentioning it is not an import. The use is matched on a call, because an unused import wraps no
 * request: it type-checks, it ships, and it screens nothing.
 */
function importsAndUsesGuard(source: string): boolean {
  const stripped = stripComments(source);
  const declarations = guardImportDeclarations(stripped);
  if (declarations.length === 0) return false;

  const bound = new Set<string>();
  for (const declaration of declarations) for (const name of boundNames(declaration)) bound.add(name);
  if (bound.size === 0) return false;

  // The declarations themselves are removed before looking for a use. Inside an import clause a name is
  // followed by a comma, which is what let `import { protectFetch, screenResponse } from "./guard"` count
  // as using both of them while calling neither.
  let body = stripped;
  for (const declaration of declarations) body = body.split(declaration).join(' ');

  // A use is a call, or being passed somewhere, or a property read off a namespace import — all three put
  // the guard in the request path; none of them is the import line.
  return [...bound].some((name) => new RegExp(`\\b${escapeForRegExp(name)}\\s*[(),.]`).test(body));
}

/**
 * The import or require statements that bring in the guard module, verbatim.
 *
 * Matched on a real import or require of the guard path, not on the path appearing anywhere — a comment
 * mentioning it is not an import, and neither is a string that happens to contain it.
 */
function guardImportDeclarations(stripped: string): string[] {
  const marker = escapeForRegExp(GUARD_MARKER);
  const pattern = new RegExp(
    `import\\s+[^;]*?from\\s*['"\`][^'"\`]*${marker}[^'"\`]*['"\`]` +
      `|(?:const|let|var)\\s+[^;=]+=\\s*require\\(\\s*['"\`][^'"\`]*${marker}[^'"\`]*['"\`]\\s*\\)`,
    'g',
  );

  return stripped.match(pattern) ?? [];
}

/**
 * The LOCAL names a guard import declaration binds.
 *
 * Local, because that is the name the code below has to call. An alias (`protectFetch as guard`) binds
 * `guard`, and looking for the exported name instead would refuse a correctly wired app.
 */
function boundNames(declaration: string): string[] {
  const names: string[] = [];
  const clause = /^import\s+([^]*?)\s+from\b/.exec(declaration)?.[1]
    ?? /^(?:const|let|var)\s+([^]*?)=\s*require\b/.exec(declaration)?.[1]
    ?? '';

  const braced = /\{([^}]*)\}/.exec(clause)?.[1];
  if (braced !== undefined) {
    for (const part of braced.split(',')) {
      const local = part.includes(' as ')
        ? part.split(' as ').pop()
        : part.includes(':')
          ? part.split(':').pop()
          : part;
      const name = (local ?? '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }

  // A default or namespace binding: `import guard from`, `import * as guard from`, `const guard = require`.
  const bare = clause.replace(/\{[^}]*\}/g, '').replace(/^\*\s*as\s*/, '').replace(/,/g, ' ').trim();
  for (const token of bare.split(/\s+/)) {
    if (/^[A-Za-z_$][\w$]*$/.test(token) && token !== 'as') names.push(token);
  }

  return names;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function genericVerify(cwd: string): VerifyResult {
  const dir = genericDir(cwd);
  const scaffolded = existsSync(join(cwd, dir, 'guard.ts'));
  const imported = scaffolded && guardIsImported(cwd, join(cwd, dir, 'guard.ts'));
  return {
    wired: scaffolded && imported,
    checks: [
      { label: 'generic guard scaffolded', ok: scaffolded, hint: 'run `patchstack-connect protect`' },
      {
        label: 'guard imported and called in a server entry',
        ok: imported,
        hint: `import { protectFetch } (or patchstackMiddleware) from "${dir}/guard" and wire it into your request path — an import that is never called screens nothing`,
      },
    ],
  };
}

/**
 * Directories whose contents are not the running application.
 *
 * A guard imported in a test or present in build output protects nothing at runtime, and finding it there
 * turned the check green. Mirrors the same skip list the app-instance search uses, for the same reason.
 */
const NON_RUNTIME_DIRS = new Set([
  'node_modules', 'patchstack', 'dist', 'build', 'out', 'coverage', '.next', '.output', '.svelte-kit',
  'test', 'tests', '__tests__', 'e2e', 'examples', 'fixtures', '__fixtures__', 'stories', '__mocks__',
]);

/**
 * Is one of the guard's exports actually imported and used somewhere in the app's own source?
 *
 * Three things a substring search could not tell apart, all of which reported the guard wired:
 *
 * - a commented-out line, or a note mentioning the path;
 * - the import present with the helper never called, so nothing wraps a request;
 * - the file living in test or build output rather than in the application.
 *
 * So this looks for an import of the guard module AND a use of what it imported, in a file that is part of
 * the running app. Still not a parser — it cannot prove the wrapped handler is the one the platform serves
 * — and the printed plan says which edit remains, rather than the check claiming more than it established.
 */
function guardIsImported(cwd: string, guardPath: string): boolean {
  const root = existsSync(join(cwd, 'src')) ? join(cwd, 'src') : cwd;
  let found = false;
  const walk = (d: string, depth: number): void => {
    if (found || depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (found) return;
      if (NON_RUNTIME_DIRS.has(name) || name.startsWith('.')) continue;
      const p = join(d, name);
      let st;
      try {
        st = lstatSync(p); // don't follow symlinks (avoids symlink-cycle recursion)
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(name) && p !== guardPath) {
        try {
          if (importsAndUsesGuard(readFileSync(p, 'utf8'))) found = true;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root, 0);
  return found;
}
