// Generic fallback for stacks no built-in adapter matches. Rather than silently skip, we scaffold
// a framework-agnostic guard, print a wiring plan (with best-effort entry-point detection), and
// provide a `--check` verifier — so the builder's own agent can finish the wiring and confirm it,
// entirely through the CLI (no server, no hosted infra).

import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { bakeSiteUuid, read, templatesDir } from './util.js';
import type { WireOptions, VerifyResult } from './types.js';
import { stripComments, maskStringContents } from './source-scope.js';

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

/**
 * The guard exports that put it in the request path. One of these has to be imported, and used.
 *
 * The guard also exports `getProtection`, which builds the policy and screens nothing on its own. Accepting
 * any exported name meant a file that imported and called that one verified as wired — a policy built, and
 * no request going through it.
 */
const GUARD_EXPORTS = ['protectFetch', 'patchstackMiddleware', 'screenResponse'] as const;

/**
 * Whether this file imports the guard module and uses what it imported.
 *
 * Three ways a file can carry the guard's name without running it, and all three had to be closed:
 * a comment, an import clause (where a name is followed by a comma, which a use test read as use), and a
 * string literal (which is just a place to put code-shaped text). So the question is asked about code:
 * comments removed, string CONTENTS blanked, and the declarations themselves excluded from the search for
 * a use. What is left is what executes.
 */
function importsAndUsesGuard(source: string): boolean {
  const code = stripComments(source);
  // Same length as `code`, so a match found here can be read back out of `code` — which is how the module
  // specifier is recovered after being blanked.
  const masked = maskStringContents(code);

  const declarations = guardImportDeclarations(code, masked);
  if (declarations.length === 0) return false;

  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const declaration of declarations) {
    const bound = boundNames(declaration.text);
    for (const name of bound.direct) direct.add(name);
    for (const name of bound.namespaces) namespaces.add(name);
  }
  if (direct.size === 0 && namespaces.size === 0) return false;

  // The declarations are blanked before looking for a use, so the import clause cannot supply it.
  let body = masked;
  for (const declaration of declarations) {
    body = body.slice(0, declaration.start) + ' '.repeat(declaration.text.length) + body.slice(declaration.start + declaration.text.length);
  }

  // A use is a call or being passed somewhere — both put the guard in the request path, and neither is the
  // import line. A namespace binding has to reach one of the screening exports THROUGH it, because the
  // object itself says nothing about which member the app went on to use.
  const members = GUARD_EXPORTS.map(escapeForRegExp).join('|');

  return (
    [...direct].some((name) => new RegExp(`\\b${escapeForRegExp(name)}\\s*[(),]`).test(body)) ||
    [...namespaces].some((name) =>
      new RegExp(`\\b${escapeForRegExp(name)}\\s*\\.\\s*(?:${members})\\s*[(),]`).test(body),
    )
  );
}

/** An import or require declaration of the guard module: its source text and where it starts. */
interface GuardDeclaration {
  text: string;
  start: number;
}

/**
 * The import or require statements that bring in the guard module.
 *
 * Found on the MASKED text, so a string holding an import statement is one opaque token rather than a
 * declaration. The specifier is then read out of the unmasked text at the same offsets and checked for the
 * guard path — the check the masking makes possible, rather than one it gets in the way of.
 */
function guardImportDeclarations(code: string, masked: string): GuardDeclaration[] {
  const pattern = /import\s+[^;]*?from\s*(['"`])[^'"`]*\1|(?:const|let|var)\s+[^;=]+=\s*require\(\s*(['"`])[^'"`]*\2\s*\)/g;
  const found: GuardDeclaration[] = [];

  for (const match of masked.matchAll(pattern)) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    const text = code.slice(start, start + match[0].length);
    if (specifierOf(text)?.includes(GUARD_MARKER) === true) found.push({ text, start });
  }

  return found;
}

/** The module string of a declaration, read from the unmasked text. */
function specifierOf(declaration: string): string | null {
  return /(['"`])([^'"`]*)\1/.exec(declaration)?.[2] ?? null;
}

/**
 * The LOCAL names a guard import declaration binds, split by how they can be used.
 *
 * `direct` are locals bound to one of the screening exports. Local, because that is the name the code below
 * has to call: an alias (`protectFetch as shield`) binds `shield`, and looking for the exported name would
 * refuse a correctly wired app. The EXPORTED name is what has to be a screening one — importing
 * `getProtection` under any local name still screens nothing.
 *
 * `namespaces` are whole-module bindings: `import * as g`, `import g from`, `const g = require(...)`. What
 * they bind says nothing about which member the app used, so the caller asks for a member call instead.
 */
function boundNames(declaration: string): { direct: string[]; namespaces: string[] } {
  const direct: string[] = [];
  const namespaces: string[] = [];
  const clause =
    /^import\s+([^]*?)\s+from\b/.exec(declaration)?.[1] ??
    /^(?:const|let|var)\s+([^]*?)=\s*require\b/.exec(declaration)?.[1] ??
    '';

  const braced = /\{([^}]*)\}/.exec(clause)?.[1];
  if (braced !== undefined) {
    for (const part of braced.split(',')) {
      const [exported, local] = splitBinding(part);
      if (!isGuardExport(exported)) continue;
      if (/^[A-Za-z_$][\w$]*$/.test(local)) direct.push(local);
    }
  }

  const bare = clause.replace(/\{[^}]*\}/g, '').replace(/^\*\s*as\s*/, '').replace(/,/g, ' ').trim();
  for (const token of bare.split(/\s+/)) {
    if (/^[A-Za-z_$][\w$]*$/.test(token) && token !== 'as') namespaces.push(token);
  }

  return { direct, namespaces };
}

/** `name`, `name as local`, `name: local` — the exported name and the local one it binds. */
function splitBinding(part: string): [string, string] {
  const separator = part.includes(' as ') ? ' as ' : part.includes(':') ? ':' : null;
  if (separator === null) {
    const name = part.trim();

    return [name, name];
  }

  const [exported, ...rest] = part.split(separator);

  return [(exported ?? '').trim(), (rest.join(separator) ?? '').trim()];
}

function isGuardExport(name: string): boolean {
  return (GUARD_EXPORTS as readonly string[]).includes(name);
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
