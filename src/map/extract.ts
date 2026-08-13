import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, isAbsolute, dirname, resolve as resolvePath } from 'node:path';
import type { SiteInputMap, Endpoint, InputField, Sink, Flow, TsModule } from './types.js';

// Framework-AGNOSTIC input-flow extractor. It doesn't gate on a specific stack — it walks any JS/TS
// source and applies recognizer tables for (1) entry points, (2) inputs, (3) sinks, so it generalizes
// across builders (TanStack Start, Next, SvelteKit, Express/Fastify/Hono, …) and providers, and
// degrades gracefully (recording what it couldn't see in `coverage.notes`). Add a stack by adding a
// recognizer, not a new adapter.
//
// False-positive control: sink and validator recognizers are gated on the file's module bindings —
// a call whose receiver is a plain local object/class/function is NOT a dependency sink, and
// `.object({…})` is only read as an input schema when its receiver traces to a known validator
// package. Receivers that can't be traced (handler params, cross-file imports) stay heuristic,
// favoring recall over precision.

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
// One list drives BOTH the AST route-registration recognizer and the textual pre-filter — they must
// never diverge: a file the pre-filter skips is invisible to every recognizer.
const ROUTE_REGISTER_NAMES = ['get', 'post', 'put', 'patch', 'delete', 'options', 'all', 'head', 'use'];
const ROUTE_REGISTER = new Set(ROUTE_REGISTER_NAMES);
const ROUTE_CALL_RE = new RegExp(`\\.(${[...ROUTE_REGISTER_NAMES, 'route'].join('|')})\\s*\\(`);
const DB_OPS = new Set(['insert', 'update', 'delete', 'select', 'upsert', 'rpc']);
const PRISMA_OPS = new Set(['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert', 'findFirst', 'findUnique', 'findMany', 'count', 'aggregate']);
const FS_CALLS = /^(readFile|writeFile|readFileSync|writeFileSync|appendFile|createReadStream|createWriteStream|unlink|rm|rmSync|mkdir|readdir|stat|open)$/;
const EXEC_CALLS = /^(exec|execSync|spawn|spawnSync|execFile|execFileSync|fork)$/;
const HTTP_CALLS = /^(fetch|got|request)$/;
const HTTP_MEMBER_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'request']);
const ZOD_BASE = new Set(['string', 'number', 'boolean', 'array', 'object', 'enum', 'bigint', 'date', 'record']);
// String-format refinements a validator can declare — kept on the field so a rule can pin the shape.
const STRING_FORMATS = new Set(['email', 'uuid', 'url', 'ip', 'ipv4', 'ipv6', 'cuid', 'cuid2', 'ulid', 'emoji', 'datetime', 'base64', 'jwt', 'nanoid']);
// Packages whose `.object({…})` calls describe an input schema.
const VALIDATOR_PACKAGES = new Set(['zod', 'valibot', 'yup', 'joi', '@hapi/joi', 'superstruct']);
// When a sink's base can't be traced precisely, infer its package from the file's imports of a known
// provider for that sink kind (a file almost always uses one db/http client).
const DB_PACKAGES = ['@supabase/supabase-js', '@prisma/client', 'drizzle-orm', 'knex', 'kysely', 'pg', 'mysql2', 'mysql', 'sequelize', 'typeorm', 'mongoose', 'better-sqlite3'];
const HTTP_PACKAGES = ['axios', 'got', 'node-fetch', 'undici', 'superagent', 'ky'];
const isHttpPackage = (pkg: string) => HTTP_PACKAGES.includes(pkg) || pkg === 'node:http' || pkg === 'node:https';
const BUILTINS = new Set(builtinModules);

// Per-file module bindings: resolve a local identifier to the npm package (or node: builtin) it came
// from — directly (an import), or via `const x = <importedFn|new ImportedClass>(...)` /
// `const x = require('mod')`; derived names resolve transitively (`const conn = pool.promise()`).
// `imports` is every module specifier the file imports (for the fallback). `locals` is every name
// declared in-file that does NOT trace to a module — calls on those receivers are not dependency
// sinks. (Names assigned outside their declaration, e.g. `let fs; fs = require('fs')`, are treated
// as local — an accepted miss.)
interface Bindings {
  resolve(name: string): string | undefined;
  imports: Set<string>;
  locals: Set<string>;
}
function buildModuleBindings(sf: any, ts: TsModule): Bindings {
  const nameToModule = new Map<string, string>(); // local name → module specifier
  const declared = new Set<string>(); // every name declared in this file
  const imports = new Set<string>();

  const record = (local: string, mod: string) => { nameToModule.set(local, mod); imports.add(mod); };
  const declareBound = (nameNode: any) => {
    if (ts.isIdentifier(nameNode)) declared.add(nameNode.text);
    else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
      for (const el of nameNode.elements) if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) declared.add(el.name.text);
    }
  };

  const visit = (node: any) => {
    // import … from 'mod'
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const mod = node.moduleSpecifier.text;
      imports.add(mod);
      const clause = node.importClause;
      if (clause?.name) record(clause.name.text, mod); // default
      const nb = clause?.namedBindings;
      if (nb) {
        if (ts.isNamespaceImport(nb)) record(nb.name.text, mod);
        else if (ts.isNamedImports(nb)) for (const el of nb.elements) record(el.name.text, mod);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) declared.add(node.name.text);
    if (ts.isClassDeclaration(node) && node.name) declared.add(node.name.text);
    // const x = require('mod')  /  const { a } = require('mod')
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        declareBound(decl.name);
        const init = decl.initializer;
        const reqMod = requireSpecifier(init, ts);
        if (reqMod) {
          if (ts.isIdentifier(decl.name)) record(decl.name.text, reqMod);
          else if (ts.isObjectBindingPattern(decl.name)) for (const el of decl.name.elements) if (ts.isIdentifier(el.name)) record(el.name.text, reqMod);
        }
        // const x = tracedFactory(...)  /  const x = new TracedClass(...)  → x carries that package.
        // Looking up nameToModule (not just direct imports) makes this transitive: pool → conn → ….
        // Recorded as pending too, so a factory resolved LATER (a local wrapper, below) still binds x.
        if (init && ts.isIdentifier(decl.name)) {
          const callee = ts.isCallExpression(init) ? init.expression : ts.isNewExpression(init) ? init.expression : undefined;
          const root = callee ? rootIdentifier(callee, ts) : undefined;
          if (root) {
            pending.push([decl.name.text, root]);
            if (nameToModule.has(root)) record(decl.name.text, nameToModule.get(root)!);
          }
        }
      }
    }
    // A LOCAL factory that hands back a dependency object: `function getClient() { return createClient(…) }`.
    // Without this, `const supabase = getClient()` looks like a plain local and every sink on it is
    // dropped as "not a dependency" — silently losing the real client (the common AI-generated shape).
    if ((ts.isFunctionDeclaration(node) || isFnLike(node, ts)) && node.body) {
      const fnName = ts.isFunctionDeclaration(node) && node.name
        ? node.name.text
        : ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
          ? node.parent.name.text
          : undefined;
      if (fnName) {
        const root = returnedRootIdentifier(node.body, ts);
        if (root) pending.push([fnName, root]);
      }
    }
    ts.forEachChild(node, visit);
  };
  const pending: Array<[string, string]> = []; // [localName, rootIdentifierItCameFrom]
  visit(sf);
  // Fixpoint: resolve chains like createClient → getClient → supabase (bounded; order-independent).
  for (let i = 0; i < 4; i++) {
    let changed = false;
    for (const [name, root] of pending) {
      if (!nameToModule.has(name) && nameToModule.has(root)) { record(name, nameToModule.get(root)!); changed = true; }
    }
    if (!changed) break;
  }
  const locals = new Set([...declared].filter((n) => !nameToModule.has(n)));
  return { resolve: (name: string) => nameToModule.get(name), imports, locals };
}

// Root identifier of what a function body returns (`return createClient(…)` → "createClient"), for
// following a local factory to the dependency it wraps. Concise arrow bodies are the expression itself.
function returnedRootIdentifier(body: any, ts: TsModule): string | undefined {
  if (!ts.isBlock(body)) return rootIdentifier(body, ts); // concise arrow body
  let found: string | undefined;
  const visit = (n: any) => {
    if (found) return;
    if (isUninvokedFunctionDeclaration(n, ts) && n !== body) return; // don't read a nested fn's return
    if (ts.isReturnStatement(n) && n.expression) { found = rootIdentifier(n.expression, ts); return; }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

function requireSpecifier(init: any, ts: TsModule): string | undefined {
  if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require') {
    const a = init.arguments[0];
    if (a && ts.isStringLiteralLike(a)) return a.text;
  }
  return undefined;
}

// Leftmost identifier of a member/call chain (`supabase.from(x).insert` → "supabase", `fs.writeFile` → "fs").
function rootIdentifier(node: any, ts: TsModule): string | undefined {
  let cur = node;
  while (cur) {
    if (ts.isIdentifier(cur)) return cur.text;
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur) || ts.isCallExpression(cur) || ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) {
      cur = cur.expression;
    } else return undefined;
  }
  return undefined;
}

// Normalize a module specifier to its npm package root (keep scope, drop subpath). Node builtins are
// normalized to the `node:` form even when imported bare (`import fs from 'fs'`) — there IS an npm
// package named `fs`, and CVE correlation must never confuse the two. Relative paths → undefined.
function npmPackageOf(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  if (spec.startsWith('.') || spec.startsWith('/')) return undefined;
  if (spec.startsWith('node:')) return spec;
  if (BUILTINS.has(spec)) return `node:${spec}`;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// 1-based line of a node in its source file — the auditable coordinate rules and humans point at.
function lineOf(node: any): number | undefined {
  const sf = typeof node?.getSourceFile === 'function' ? node.getSourceFile() : undefined;
  if (!sf) return undefined;
  try { return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1; } catch { return undefined; }
}

export interface ExtractOptions {
  /** Follow symlinks that leave the project directory (off by default — keeps analysis in-project). */
  followSymlinks?: boolean;
}

export async function extractInputMap(cwd: string, ts: TsModule, options: ExtractOptions = {}): Promise<SiteInputMap> {
  const notes: string[] = [];
  const endpoints: Endpoint[] = [];
  const failed: string[] = [];
  let boundary = cwd;
  try { boundary = realpathSync(cwd); } catch { /* use cwd as-is */ }

  const graph = createModuleGraph(ts); // shared cache across files
  const stats: WalkStats = { discovered: 0 };
  const files = collectSources(cwd, boundary, { followOutside: options.followSymlinks }, [], new Set(), stats);
  let parsed = 0;

  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8');
      if (!hasEntrySignal(text)) continue;
      parsed++;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, guessScriptKind(ts, file));
      const bindings = buildModuleBindings(sf, ts);
      const localSinks = collectLocalSinks(sf, ts, bindings);
      for (const ep of extractFromFile(sf, ts, localSinks, bindings, { file, graph })) {
        const relFile = relative(cwd, file);
        // A FILE-BASED route handler carries its URL path in its location, not in the code, so derive
        // it here — without this a rule can only be param-pinned, never route-scoped (`when.path`).
        if (ep.route === undefined && ep.entryKind === 'edge-function') {
          const fn = functionNameFromPath(relFile);
          if (fn) ep.route = '/' + fn; // how the platform invokes it (…/functions/v1/<name>)
        }
        if (ep.route === undefined && (ep.entryKind === 'route-handler' || ep.entryKind === 'server-action')) {
          const derived = routeFromFilePath(relFile);
          if (derived.route) {
            ep.route = derived.route;
            if (derived.dynamic) ep.routeDynamic = true;
          }
        }
        endpoints.push({ ...ep, file: relFile });
      }
    } catch {
      // Fail-open: one unreadable/unparseable file must never kill the whole map.
      failed.push(relative(cwd, file));
    }
  }

  notes.push('Static analysis is best-effort — this is the DETECTED surface, not a proof of completeness.');
  notes.push('`inputs` and `sinks` are INVENTORIES (both present in the handler). Only `flows` asserts that an input reaches a sink — prefer flows with confidence "precise" when pinning a rule to a parameter.');
  notes.push('Sinks are followed into same-file helpers and ONE hop into an imported relative module (a dependency\u2019s internals are not followed); deeper or dynamic indirection is not traced. Sinks inside declared-but-uncalled local functions are excluded.');
  notes.push('A sink `package` is resolved from the file’s imports (precise) or inferred from a known provider import; an unresolved package means the backing dependency could not be traced.');
  if (!options.followSymlinks) notes.push('Symlinks leaving the project directory were not followed (use --follow-symlinks to include them).');
  if (failed.length > 0) {
    const sample = failed.slice(0, 5).join(', ');
    notes.push(`${failed.length} file(s) could not be analyzed and were skipped (fail-open): ${sample}${failed.length > 5 ? ', …' : ''}.`);
  }
  const unresolved = endpoints.filter((e) => e.inputsResolved === false).length;
  if (unresolved > 0) {
    notes.push(`${unresolved} endpoint(s) declare an input validator that could not be statically parsed — their inputs are UNKNOWN, not empty (marked inputsResolved: false).`);
  }
  const heuristicOnly = endpoints.filter((e) => e.sinks.length > 0 && e.inputs.length > 0 && !e.flows.some((f) => f.confidence === 'precise')).length;
  if (heuristicOnly > 0) {
    notes.push(`${heuristicOnly} endpoint(s) have inputs and sinks but no PRECISE data link — their flows are "heuristic" (may reach), not proven.`);
  }
  if (endpoints.length === 0) notes.push('No recognized server-side entry points found under the analyzed roots.');

  return {
    version: 1,
    framework: detectFramework(cwd),
    endpoints,
    coverage: {
      adapter: 'agnostic-v1',
      filesDiscovered: stats.discovered,
      filesParsed: parsed,
      filesSkipped: failed.length,
      roots: ['.'],
      notes,
    },
  };
}

// Cheap textual pre-filter so we only parse files that could contain an entry point. Derived from the
// same list as the AST recognizer (see ROUTE_REGISTER_NAMES).
function hasEntrySignal(text: string): boolean {
  return (
    text.includes('createServerFn') ||
    /\bexport\s+(async\s+)?(function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(text) ||
    ROUTE_CALL_RE.test(text) ||
    text.includes("'use server'") || text.includes('"use server"') ||
    text.includes('Deno.serve') || /\bserve\s*\(/.test(text)
  );
}

function detectFramework(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const d = { ...pkg.dependencies, ...pkg.devDependencies };
    if (d['@tanstack/react-start'] || d['@tanstack/start'] || d['@tanstack/solid-start']) return 'tanstack-start';
    if (d['next']) return 'next';
    if (d['@sveltejs/kit']) return 'sveltekit';
    if (d['@nestjs/core']) return 'nestjs';
    if (d['fastify']) return 'fastify';
    if (d['express']) return 'express';
    if (d['hono']) return 'hono';
  } catch { /* ignore */ }
  // A Deno/edge functions project may have no package.json at all.
  try {
    if (statSync(join(cwd, 'supabase', 'functions')).isDirectory()) return 'supabase-functions';
  } catch { /* not a supabase project */ }
  try {
    if (statSync(join(cwd, 'functions')).isDirectory()) return 'deno-functions';
  } catch { /* ignore */ }
  return 'unknown';
}

function guessScriptKind(ts: TsModule, file: string) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const isSourceFile = (name: string) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts');

// Directories that never hold app source, so walking the whole project stays cheap. (We walk the whole
// project rather than `src` only: server entrypoints, route dirs and platform function dirs commonly
// live at the root — `server.ts`, `app/`, `api/`, `routes/`, `functions/`, `netlify/`, `supabase/`.)
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'public', 'static', 'assets',
  '.git', '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.wrangler', '.turbo', '.cache',
  'vendor', 'tmp', 'temp', '__pycache__',
]);

export interface WalkStats { discovered: number }

/**
 * Walk the project for source files. Symlinks are followed ONLY while they stay inside the project
 * boundary (`boundary`, a realpath) — a link to an external repo would otherwise pull unrelated code
 * (and its paths) into the map. `followOutside` opts out of the boundary check. A realpath visited-set
 * makes link cycles safe.
 */
function collectSources(
  dir: string,
  boundary: string,
  opts: { followOutside?: boolean },
  out: string[] = [],
  seen = new Set<string>(),
  stats: WalkStats = { discovered: 0 },
): string[] {
  let key: string;
  try { key = realpathSync(dir); } catch { return out; }
  if (seen.has(key)) return out;
  if (!opts.followOutside && !isInside(key, boundary)) return out;
  seen.add(key);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) collectSources(full, boundary, opts, out, seen, stats);
    else if (e.isSymbolicLink()) {
      let st, real;
      try { st = statSync(full); real = realpathSync(full); } catch { continue; }
      if (!opts.followOutside && !isInside(real, boundary)) continue; // link escapes the project
      if (st.isDirectory()) collectSources(full, boundary, opts, out, seen, stats);
      else if (st.isFile() && isSourceFile(e.name)) { out.push(full); stats.discovered++; }
    } else if (isSourceFile(e.name)) { out.push(full); stats.discovered++; }
  }
  return out;
}

function isInside(candidate: string, boundary: string): boolean {
  if (candidate === boundary) return true;
  const rel = relative(boundary, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Derive the URL path of a FILE-BASED route handler from its location, across the conventions AI
// builders actually emit. Dynamic segments become `:name` and set `dynamic` so a consumer knows the
// route is a PATTERN (the engine's `when.path` takes a glob or /regex/, not an Express param), rather
// than mistaking `/api/:id` for a literal path.
//   Next App Router     app/api/items/route.ts          -> /api/items
//                       app/api/items/[id]/route.ts     -> /api/items/:id      (dynamic)
//                       app/(marketing)/api/x/route.ts  -> /api/x              (route group stripped)
//   Next Pages Router   pages/api/items/index.ts        -> /api/items
//                       pages/api/[id].ts               -> /api/:id            (dynamic)
//   SvelteKit           src/routes/api/items/+server.ts -> /api/items
//   Nuxt                server/api/items.post.ts        -> /api/items
// The deployed name of a platform function, from its conventional location:
//   supabase/functions/<name>/index.ts  (Supabase Edge Functions)
//   functions/<name>/index.ts | functions/<name>.ts  (Base44 / generic Deno function dirs)
export function functionNameFromPath(relFile: string): string | undefined {
  const parts = relFile.split(/[\\/]/).filter(Boolean);
  const i = parts.lastIndexOf('functions');
  if (i === -1 || i === parts.length - 1) return undefined;
  const next = parts[i + 1];
  if (!next) return undefined;
  const base = next.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '');
  return base === 'index' ? undefined : base;
}

export function routeFromFilePath(relFile: string): { route?: string; dynamic?: boolean } {
  const parts = relFile.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return {};
  const base = (parts[parts.length - 1] ?? '').replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '');
  const dirs = parts.slice(0, -1);
  const at = (name: string) => dirs.lastIndexOf(name);

  let segs: string[] | null = null;
  if (base === 'route' && at('app') !== -1) {
    segs = dirs.slice(at('app') + 1); // Next App Router
  } else if (base === '+server' && at('routes') !== -1) {
    segs = dirs.slice(at('routes') + 1); // SvelteKit
  } else if (at('pages') !== -1) {
    segs = [...dirs.slice(at('pages') + 1), ...(base === 'index' ? [] : [base])]; // Next Pages Router
  } else if (at('server') !== -1) {
    // Nuxt server routes; a `.post`/`.get` suffix encodes the method, not a path segment.
    segs = [...dirs.slice(at('server') + 1), ...(base === 'index' ? [] : [base.replace(/\.(get|post|put|patch|delete|head|options)$/i, '')])];
  }
  if (!segs) return {};

  // Next route groups `(marketing)` and parallel/private segments don't appear in the URL.
  segs = segs.filter((s) => !(s.startsWith('(') && s.endsWith(')')) && !s.startsWith('@') && !s.startsWith('_'));

  let dynamic = false;
  const mapped = segs.map((s) => {
    const m = /^\[+(\.{0,3})(.+?)\]+$/.exec(s); // [id], [...slug], [[...slug]]
    if (m) {
      dynamic = true;
      return ':' + m[2];
    }
    return s;
  });
  const route = '/' + mapped.join('/');
  return { route: route.length > 1 ? route.replace(/\/+$/, '') : '/', dynamic };
}

// --- entry-point recognizers -----------------------------------------------
function extractFromFile(sf: any, ts: TsModule, localSinks: Map<string, Sink[]>, bindings: Bindings, ctx: { file: string; graph: ModuleGraph }): Omit<Endpoint, 'file'>[] {
  const out: Omit<Endpoint, 'file'>[] = [];
  const isServerActionsFile = fileHasUseServer(sf, ts);

  const visit = (node: any) => {
    if (ts.isVariableStatement(node) && hasExport(node, ts)) {
      for (const decl of node.declarationList.declarations) {
        // (1) TanStack Start: `export const NAME = createServerFn({method}).inputValidator(fn).handler(fn)`
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          const chain = unwindChain(decl.initializer, ts);
          if (chain.baseName === 'createServerFn' && ts.isIdentifier(decl.name)) {
            const validatorCall = chain.calls['inputValidator'] ?? chain.calls['validator'];
            const inputs = inputsFromValidator(validatorCall, ts, bindings);
            const handlerFn = chain.calls['handler']?.arguments?.[0];
            const sinks = sinksFrom(handlerFn, ts, localSinks, bindings, ctx);
            const handlerBody = handlerFn && isFnLike(handlerFn, ts) ? handlerFn.body : undefined;
            const ep: Omit<Endpoint, 'file'> = {
              name: decl.name.text,
              entryKind: 'server-fn',
              method: methodFromObjectArg(chain.baseCall, ts),
              line: lineOf(decl),
              inputs,
              sinks,
              flows: linkFlows(handlerBody, handlerFn?.parameters, inputs, sinks, ts),
            };
            // Honesty marker: a validator EXISTS but couldn't be read — inputs are unknown, not "none".
            if (validatorCall && inputs.length === 0) ep.inputsResolved = false;
            out.push(ep);
            continue;
          }
        }
        // (2b) `export const POST = (req) => …` route handler, or a `'use server'` action arrow.
        if (ts.isIdentifier(decl.name) && decl.initializer && isFnLike(decl.initializer, ts)) {
          if (HTTP_METHODS.has(decl.name.text)) {
            out.push(handlerEntry(decl.name.text, decl.name.text, decl.initializer.parameters, decl.initializer.body, ts, localSinks, bindings, ctx, { line: lineOf(decl) }));
          } else if (isServerActionsFile) {
            out.push(handlerEntry(decl.name.text, 'server-action', decl.initializer.parameters, decl.initializer.body, ts, localSinks, bindings, ctx, { line: lineOf(decl) }));
          }
        }
      }
    }

    // (2a) Route handlers / server actions declared as functions.
    if (ts.isFunctionDeclaration(node) && node.name && hasExport(node, ts)) {
      if (HTTP_METHODS.has(node.name.text)) {
        out.push(handlerEntry(node.name.text, node.name.text, node.parameters, node.body, ts, localSinks, bindings, ctx, { line: lineOf(node) }));
      } else if (isServerActionsFile || hasUseServerDirective(node, ts)) {
        out.push(handlerEntry(node.name.text, 'server-action', node.parameters, node.body, ts, localSinks, bindings, ctx, { line: lineOf(node) }));
      }
    }

    // (2c) Deno / WinterCG function entry: `Deno.serve(handler)` or `serve(handler)` — Supabase Edge
    // Functions, Base44 backend functions, Deno workers. These platforms have no router and no route
    // file: one handler per module, invoked by the function's NAME, so the endpoint's identity comes
    // from the file location. Without this recognizer such a project maps to nothing at all.
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      const denoServe = ts.isPropertyAccessExpression(c) && c.name.text === 'serve' &&
        ts.isIdentifier(c.expression) && c.expression.text === 'Deno';
      const bareServe = ts.isIdentifier(c) && c.text === 'serve';
      if (denoServe || bareServe) {
        const handler = node.arguments.find((a: any) => isFnLike(a, ts));
        if (handler) {
          out.push(handlerEntry(functionNameFromPath(ctx.file) ?? 'serve', 'edge-function', handler.parameters, handler.body, ts, localSinks, bindings, ctx, { line: lineOf(node) }));
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const mname = node.expression.name.text;
      // (3a) Route registrations: `app.post('/path', …, handler)` (Express/Fastify/Hono/Koa) and the
      // chained `router.route('/x').get(handler)` idiom (path lives on the inner `.route()` call).
      if (ROUTE_REGISTER.has(mname)) {
        const args = node.arguments;
        const first = args[0];
        const route = first && ts.isStringLiteralLike(first) ? first.text : routeFromChain(node.expression.expression, ts);
        const handler = args[args.length - 1];
        if (route !== undefined && handler && isFnLike(handler, ts)) {
          out.push(handlerEntry(route, 'route-registration', handler.parameters, handler.body, ts, localSinks, bindings, ctx, {
            // `use`/`all` register handlers but are not HTTP methods — leave method undefined.
            method: HTTP_METHODS.has(mname.toUpperCase()) ? mname.toUpperCase() : undefined,
            route,
            line: lineOf(node),
          }));
        }
      }
      // (3b) Fastify object form: `app.route({ method, url, handler })` — one endpoint per method.
      if (mname === 'route') {
        const arg = node.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const reg = routeObject(arg, ts);
          if (reg.url && reg.handler) {
            for (const m of reg.methods.length ? reg.methods : [undefined]) {
              out.push(handlerEntry(reg.url, 'route-registration', reg.handler.parameters, reg.handler.body, ts, localSinks, bindings, ctx, { method: m, route: reg.url, line: lineOf(node) }));
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// Unwind `router.route('/x').get(h).post(h2)` down to the `.route('/x')` call to recover the path.
function routeFromChain(expr: any, ts: TsModule): string | undefined {
  let cur = expr;
  while (cur && ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const nm = cur.expression.name.text;
    if (nm === 'route') {
      const a = cur.arguments[0];
      return a && ts.isStringLiteralLike(a) ? a.text : undefined;
    }
    if (!ROUTE_REGISTER.has(nm)) return undefined;
    cur = cur.expression.expression;
  }
  return undefined;
}

// Read `{ method, url|path, handler }` from a Fastify-style route object (handler as arrow/function
// property or as an object-method shorthand).
function routeObject(obj: any, ts: TsModule): { url?: string; methods: string[]; handler?: any } {
  let url: string | undefined;
  let handler: any;
  const methods: string[] = [];
  for (const p of obj.properties) {
    const key = (p.name as any)?.text;
    if (ts.isPropertyAssignment(p)) {
      if ((key === 'url' || key === 'path') && ts.isStringLiteralLike(p.initializer)) url = p.initializer.text;
      if (key === 'method') {
        if (ts.isStringLiteralLike(p.initializer)) methods.push(p.initializer.text.toUpperCase());
        else if (ts.isArrayLiteralExpression(p.initializer)) {
          for (const el of p.initializer.elements) if (ts.isStringLiteralLike(el)) methods.push(el.text.toUpperCase());
        }
      }
      if (key === 'handler' && isFnLike(p.initializer, ts)) handler = p.initializer;
    } else if (ts.isMethodDeclaration(p) && key === 'handler') handler = p;
  }
  return { url, methods, handler };
}

// Next server actions: a `'use server'` directive at the top of a module (whole file) or a function body.
function fileHasUseServer(sf: any, ts: TsModule): boolean {
  const first = sf.statements?.[0];
  return Boolean(first && ts.isExpressionStatement(first) && ts.isStringLiteralLike(first.expression) && first.expression.text === 'use server');
}
function hasUseServerDirective(fn: any, ts: TsModule): boolean {
  const first = fn.body?.statements?.[0];
  return Boolean(first && ts.isExpressionStatement(first) && ts.isStringLiteralLike(first.expression) && first.expression.text === 'use server');
}

function handlerEntry(
  name: string,
  kindLabel: string,
  params: any,
  body: any,
  ts: TsModule,
  localSinks: Map<string, Sink[]>,
  bindings: Bindings,
  ctx: { file: string; graph: ModuleGraph },
  extra: { method?: string; route?: string; line?: number } = {},
): Omit<Endpoint, 'file'> {
  const entryKind = kindLabel === 'route-registration' || kindLabel === 'server-action' || kindLabel === 'edge-function'
    ? kindLabel
    : 'route-handler';
  const inputs = inputsFromHandler(params, body, ts, bindings);
  const sinks = sinksFrom({ body, parameters: params, isSyntheticBody: true }, ts, localSinks, bindings, ctx);
  return {
    name,
    entryKind,
    method: extra.method ?? (HTTP_METHODS.has(name) ? name : undefined),
    route: extra.route,
    line: extra.line,
    inputs,
    sinks,
    flows: linkFlows(body, params, inputs, sinks, ts),
  };
}

function isFnLike(n: any, ts: TsModule): n is import('typescript').ArrowFunction | import('typescript').FunctionExpression {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n);
}
function hasExport(node: any, ts: TsModule): boolean {
  return Boolean(node.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword));
}

// --- call-chain + method ----------------------------------------------------
function unwindChain(node: any, ts: TsModule): { baseName?: string; baseCall?: any; calls: Record<string, any> } {
  const calls: Record<string, any> = {};
  let cur = node;
  while (cur && ts.isCallExpression(cur)) {
    const callee = cur.expression;
    if (ts.isPropertyAccessExpression(callee)) { calls[callee.name.text] = cur; cur = callee.expression; }
    else if (ts.isIdentifier(callee)) return { baseName: callee.text, baseCall: cur, calls };
    else break;
  }
  return { calls };
}

function methodFromObjectArg(baseCall: any, ts: TsModule): string | undefined {
  const arg = baseCall?.arguments?.[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
  for (const p of arg.properties) {
    if (ts.isPropertyAssignment(p) && (p.name as any)?.text === 'method' && ts.isStringLiteralLike(p.initializer)) {
      return p.initializer.text.toUpperCase();
    }
  }
  return undefined;
}

// --- inputs -----------------------------------------------------------------
function inputsFromValidator(validatorCall: any, ts: TsModule, bindings: Bindings): InputField[] {
  if (!validatorCall) return [];
  return zodObjectFields(validatorCall, ts, bindings);
}

// From a raw handler: validator schema fields it parses, plus the request fields it actually reads
// (member accesses, destructuring, `await request.json()` bodies).
function inputsFromHandler(params: any, body: any, ts: TsModule, bindings: Bindings): InputField[] {
  const fields = zodObjectFields(body, ts, bindings);
  const names = new Set(fields.map((f) => f.name));
  for (const n of requestMemberAccesses(params, body, ts)) {
    if (!names.has(n)) { names.add(n); fields.push({ name: n }); }
  }
  return fields;
}

// Find the first validator `.object({...})` in a subtree — gated on the receiver tracing to a known
// validator package (so an unrelated `.object(` never becomes a schema). An untraceable receiver
// literally named `z` is accepted as a heuristic (covers `z` re-exported from a local module).
function findValidatorObject(node: any, ts: TsModule, bindings: Bindings): any {
  let found: any = null;
  const find = (n: any) => {
    if (found || !n) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'object') {
      const root = rootIdentifier(n.expression.expression, ts);
      const pkg = root ? npmPackageOf(bindings.resolve(root)) : undefined;
      const isValidator = (pkg && VALIDATOR_PACKAGES.has(pkg)) || (!pkg && root === 'z' && !bindings.locals.has(root));
      if (isValidator) {
        const arg = n.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) { found = arg; return; }
      }
    }
    ts.forEachChild(n, find);
  };
  find(node);
  return found;
}

// Read a validator object's fields (name + type/constraints). Nested objects/arrays are flattened to
// dotted paths — `address.city`, `tags[].label` — the same coordinates `array_key_value` rules use.
function zodObjectFields(node: any, ts: TsModule, bindings: Bindings): InputField[] {
  if (!node) return [];
  const lit = findValidatorObject(node.body ?? node, ts, bindings);
  return lit ? fieldsOfObject(lit, ts, bindings, '') : [];
}

function fieldsOfObject(objectLiteral: any, ts: TsModule, bindings: Bindings, prefix: string): InputField[] {
  const fields: InputField[] = [];
  for (const p of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(p) || !p.name) continue;
    const fname = (p.name as any).text;
    if (!fname) continue;
    const shape = zodShape(p.initializer, ts);
    fields.push({ name: prefix + fname, ...shape });
    const nested = findValidatorObject(p.initializer, ts, bindings);
    if (nested) fields.push(...fieldsOfObject(nested, ts, bindings, prefix + fname + (shape.type === 'array' ? '[].' : '.')));
  }
  return fields;
}

function numericValue(arg: any, ts: TsModule): number | undefined {
  if (!arg) return undefined;
  if (ts.isNumericLiteral(arg)) return Number(arg.text);
  if (ts.isPrefixUnaryExpression(arg) && arg.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(arg.operand)) return -Number(arg.operand.text);
  return undefined;
}

function zodShape(node: any, ts: TsModule): Omit<InputField, 'name'> {
  const shape: Omit<InputField, 'name'> = {};
  let cur = node;
  while (cur && ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const method = cur.expression.name.text;
    const arg0 = cur.arguments[0];
    if (ZOD_BASE.has(method) && !shape.type) shape.type = method;
    if (method === 'min') { const v = numericValue(arg0, ts); if (v !== undefined) shape.min = v; }
    if (method === 'max') { const v = numericValue(arg0, ts); if (v !== undefined) shape.max = v; }
    if (STRING_FORMATS.has(method) && !shape.format) shape.format = method;
    if (method === 'regex' && arg0 && ts.isRegularExpressionLiteral(arg0) && !shape.pattern) shape.pattern = arg0.text;
    if (method === 'optional' || method === 'nullish') shape.optional = true;
    cur = cur.expression.expression;
  }
  return shape;
}

const REQ_SOURCES = ['body', 'query', 'params'];

// The request fields a handler reads, across the common idioms:
//   req.body.x / req.query.x / req.params.x        (member access)
//   const { x } = req.body                          (destructuring)
//   ({ body }) => body.x / const { x } = body       (destructured handler param)
//   const b = await request.json(); b.x / const { x } = await request.json()   (fetch-style Request)
function requestMemberAccesses(params: any, body: any, ts: TsModule): string[] {
  if (!body) return [];
  const out = new Set<string>();
  const p0 = params?.[0];
  const reqName = p0 && ts.isIdentifier(p0.name) ? p0.name.text : undefined;
  // Identifiers that ARE a request-input object (destructured `({ body })` param, `await req.json()`).
  const sourceNames = new Set<string>();
  if (p0 && !reqName && ts.isObjectBindingPattern(p0.name)) {
    for (const el of p0.name.elements) {
      const key = bindingKey(el, ts);
      if (key && REQ_SOURCES.includes(key) && ts.isIdentifier(el.name)) sourceNames.add(el.name.text);
    }
  }
  const unwrap = (e: any): any => {
    let cur = e;
    while (cur && (ts.isAwaitExpression(cur) || ts.isAsExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur))) cur = cur.expression;
    return cur;
  };
  const isReqSourceExpr = (e: any): boolean =>
    (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === reqName && REQ_SOURCES.includes(e.name.text)) ||
    (ts.isIdentifier(e) && sourceNames.has(e.text));
  const isBodyReadCall = (e: any): boolean => {
    const inner = unwrap(e);
    return Boolean(inner && ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) &&
      ['json', 'formData'].includes(inner.expression.name.text) &&
      ts.isIdentifier(inner.expression.expression) && inner.expression.expression.text === reqName);
  };
  const visit = (n: any) => {
    // <source>.<field>
    if (ts.isPropertyAccessExpression(n) && isReqSourceExpr(n.expression)) out.add(n.name.text);
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = unwrap(n.initializer);
      // const b = await request.json() → b is a request-input object from here on.
      if (ts.isIdentifier(n.name) && isBodyReadCall(n.initializer)) sourceNames.add(n.name.text);
      // const { a, b } = <source> | await request.json()
      if (ts.isObjectBindingPattern(n.name) && (isReqSourceExpr(init) || isBodyReadCall(n.initializer))) {
        for (const el of n.name.elements) {
          const key = bindingKey(el, ts);
          if (key) out.add(key);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return [...out];
}

function bindingKey(el: any, ts: TsModule): string | undefined {
  if (!ts.isBindingElement(el)) return undefined;
  const prop = el.propertyName ?? el.name;
  return prop && ts.isIdentifier(prop) ? prop.text : undefined;
}

// --- sinks (agnostic) -------------------------------------------------------
function collectLocalSinks(sf: any, ts: TsModule, bindings: Bindings): Map<string, Sink[]> {
  const map = new Map<string, Sink[]>();
  const visit = (node: any) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) map.set(node.name.text, directSinks(node.body, ts, bindings));
    else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && isFnLike(decl.initializer, ts)) {
          map.set(decl.name.text, directSinks(decl.initializer.body, ts, bindings));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

// --- cross-file (imported) helper tracing -----------------------------------
// AI-generated apps routinely put the data access in a sibling module (`import { saveOrder } from
// './db'`), so a handler's real sink lives one file away. Without following that, the endpoint looks
// sink-free and no rule can be correlated to it. We follow ONE cross-file hop (plus same-file helpers
// inside the target), which covers the common shape while keeping the walk bounded and cheap.
const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export interface ModuleGraph {
  /** Sinks of `exportName` in the module `specifier` resolves to, relative to `fromFile`. */
  importedSinks(fromFile: string, specifier: string, exportName: string): Sink[];
}

function createModuleGraph(ts: TsModule): ModuleGraph {
  // file → { fnSinks, calleesOf } | null (unreadable/unparseable)
  const cache = new Map<string, { fnSinks: Map<string, Sink[]>; calleesOf: Map<string, string[]> } | null>();

  const load = (file: string) => {
    if (cache.has(file)) return cache.get(file) ?? null;
    let entry: { fnSinks: Map<string, Sink[]>; calleesOf: Map<string, string[]> } | null = null;
    try {
      const text = readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, guessScriptKind(ts, file));
      const bindings = buildModuleBindings(sf, ts);
      entry = { fnSinks: collectLocalSinks(sf, ts, bindings), calleesOf: collectCallees(sf, ts) };
    } catch {
      entry = null; // fail-open: an unreadable dependency must not break the map
    }
    cache.set(file, entry);
    return entry;
  };

  return {
    importedSinks(fromFile, specifier, exportName) {
      const target = resolveRelativeModule(fromFile, specifier);
      if (!target) return [];
      const mod = load(target);
      if (!mod) return [];
      const out = [...(mod.fnSinks.get(exportName) ?? [])];
      // One same-file hop inside the target: `export function saveOrder(){ return doInsert() }`.
      for (const callee of mod.calleesOf.get(exportName) ?? []) {
        for (const s of mod.fnSinks.get(callee) ?? []) out.push(s);
      }
      return out;
    },
  };
}

// Resolve a RELATIVE specifier to a real file (extension + /index, and the TS-ESM `./db.js` → db.ts
// convention). Bare package specifiers are intentionally NOT followed — that's node_modules, and a
// dependency's internals are not this app's attack surface.
function resolveRelativeModule(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const dir = dirname(fromFile);
  const base = resolvePath(dir, spec);
  const candidates: string[] = [];
  const jsLike = /\.(js|jsx|mjs|cjs)$/.exec(base);
  if (jsLike) {
    const stem = base.slice(0, -jsLike[0].length);
    for (const e of RESOLVE_EXTS) candidates.push(stem + e); // ./db.js may mean db.ts
  }
  candidates.push(base);
  for (const e of RESOLVE_EXTS) candidates.push(base + e);
  for (const e of RESOLVE_EXTS) candidates.push(join(base, 'index' + e));
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
  }
  return undefined;
}

// name → the local function names it calls (for one same-file hop inside an imported module).
function collectCallees(sf: any, ts: TsModule): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const visit = (node: any) => {
    let name: string | undefined;
    let body: any;
    if (ts.isFunctionDeclaration(node) && node.name && node.body) { name = node.name.text; body = node.body; }
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFnLike(node.initializer, ts)) {
      name = node.name.text; body = node.initializer.body;
    }
    if (name && body) map.set(name, localCalls(body, ts));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

function sinksFrom(arrowOrNode: any, ts: TsModule, localSinks: Map<string, Sink[]>, bindings: Bindings, ctx?: { file: string; graph: ModuleGraph }): Sink[] {
  if (!arrowOrNode) return [];
  const body = arrowOrNode.isSyntheticBody ? arrowOrNode.body
    : isFnLike(arrowOrNode, ts) ? arrowOrNode.body : arrowOrNode;
  if (!body) return [];
  const sinks = directSinks(body, ts, bindings);
  for (const called of localCalls(body, ts)) {
    // Same-file helper.
    for (const s of localSinks.get(called) ?? []) sinks.push(s);
    // Imported helper: the name resolves to a RELATIVE module → follow one hop into it.
    if (ctx) {
      const spec = bindings.resolve(called);
      if (spec && spec.startsWith('.')) {
        for (const s of ctx.graph.importedSinks(ctx.file, spec, called)) sinks.push(s);
      }
    }
  }
  return dedupeSinks(sinks);
}

// Provider-agnostic sink recognizers over a subtree. Each sink is tagged with the npm package behind
// it: resolved precisely from the call's base identifier via the file's imports, else inferred from
// the file's imports of a known provider for that sink kind. A receiver that traces to a plain local
// object/class/function is NOT a dependency sink and is dropped.
function directSinks(node: any, ts: TsModule, bindings: Bindings): Sink[] {
  const sinks: Sink[] = [];
  const baseOf = (base: any): { pkg?: string; local?: boolean; root?: string } => {
    const root = base ? rootIdentifier(base, ts) : undefined;
    if (!root) return {};
    const pkg = npmPackageOf(bindings.resolve(root));
    if (pkg) return { pkg, root };
    return { local: bindings.locals.has(root), root };
  };
  const infer = (kind: 'db' | 'http'): string | undefined => {
    const table = kind === 'db' ? DB_PACKAGES : HTTP_PACKAGES;
    for (const p of table) if (bindings.imports.has(p)) return p;
    return undefined;
  };
  const push = (s: Sink) => sinks.push(s);
  const visit = (n: any) => {
    // A function that is DECLARED here but not invoked here is not reached by this endpoint — walking
    // into it would report sinks the endpoint never touches (e.g. an unused local helper that shells
    // out). Skip those subtrees; when the handler DOES call such a helper, `localCalls` +
    // `collectLocalSinks` bring its sinks in by name. Inline callbacks / IIFEs are NOT skipped — those
    // do run (`items.map(x => db.insert(x))`, `.then(...)`).
    if (n !== node && isUninvokedFunctionDeclaration(n, ts)) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      // db: `.from("t").<op>()` (supabase/knex/kysely)
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'from') {
        const b = baseOf(callee.expression);
        const t = n.arguments[0];
        const table = t && ts.isStringLiteralLike(t) ? t.text : undefined;
        const parent = n.parent;
        if (!b.local && parent && ts.isPropertyAccessExpression(parent) && DB_OPS.has(parent.name.text)) {
          push({ kind: 'db', provider: 'sql', package: b.pkg ?? infer('db'), table, op: parent.name.text, line: lineOf(parent) });
        }
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const b = baseOf(callee.expression);
        if (!b.local) {
          // db: prisma-style `prisma.<model>.<op>()` — the op names are generic (`delete`, `update`, …),
          // so require a real prisma signal: a resolved binding, the import, or a prisma-named receiver.
          if (PRISMA_OPS.has(method) && ts.isPropertyAccessExpression(callee.expression)) {
            const prismaLikely = b.pkg === '@prisma/client' ||
              (!b.pkg && (bindings.imports.has('@prisma/client') || /prisma/i.test(b.root ?? '')));
            if (prismaLikely) push({ kind: 'db', provider: 'prisma', package: '@prisma/client', table: callee.expression.name.text, op: method, line: lineOf(n) });
          }
          // db: raw `.query(` / `.execute(`
          if (method === 'query' || method === 'execute') {
            push({ kind: 'db', provider: 'sql', package: b.pkg ?? infer('db'), op: method, line: lineOf(n) });
          }
          // fs / exec via a namespace: `fs.writeFile(` / `child_process.exec(`
          if (FS_CALLS.test(method)) push({ kind: 'fs', package: b.pkg, op: method, line: lineOf(n) });
          if (EXEC_CALLS.test(method)) push({ kind: 'exec', package: b.pkg, op: method, line: lineOf(n) });
          // http: any client whose binding resolves to a known http package (`axios.get`, `ky.post`,
          // `http.request`), else the classic identifiers by name as a heuristic.
          if (HTTP_MEMBER_METHODS.has(method)) {
            if (b.pkg && isHttpPackage(b.pkg)) {
              push({ kind: 'http', provider: b.root, package: b.pkg, op: method, line: lineOf(n) });
            } else if (!b.pkg && ts.isIdentifier(callee.expression) && /^(axios|http|https|got|ky)$/.test(callee.expression.text)) {
              push({ kind: 'http', provider: callee.expression.text, package: infer('http'), op: method, line: lineOf(n) });
            }
          }
        }
      }
      // bare calls: fetch( / exec( / readFile( / eval( — unless the name is a plain local function.
      if (ts.isIdentifier(callee) && !bindings.locals.has(callee.text)) {
        const name = callee.text;
        const pkg = npmPackageOf(bindings.resolve(name));
        // `fetch` is a global — never attribute it to an unrelated imported http client.
        if (HTTP_CALLS.test(name)) push({ kind: 'http', provider: name, package: pkg ?? (name === 'fetch' ? undefined : infer('http')), op: 'request', line: lineOf(n) });
        if (FS_CALLS.test(name)) push({ kind: 'fs', package: pkg, op: name, line: lineOf(n) });
        if (EXEC_CALLS.test(name)) push({ kind: 'exec', package: pkg, op: name, line: lineOf(n) });
        if (name === 'eval') push({ kind: 'eval', op: 'eval', line: lineOf(n) });
      }
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Function') {
      push({ kind: 'eval', op: 'new Function', line: lineOf(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return sinks;
}

// A named function *declaration*, or a function bound to a variable/property — i.e. code that only runs
// if something calls it. An inline callback (an arrow passed as an argument), an IIFE, or a function
// used directly in an expression is NOT this: those execute where they appear.
function isUninvokedFunctionDeclaration(n: any, ts: TsModule): boolean {
  if (ts.isFunctionDeclaration(n)) return true;
  if (isFnLike(n, ts)) {
    const p = n.parent;
    if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))) return true;
  }
  return false;
}

// --- input → sink flow linking ---------------------------------------------
// Evidence-backed data links: for each sink, does an INPUT identifier/path appear inside the sink
// call's arguments? "Tainted" roots are the handler's own parameter names (`{ data }`, `req`) plus any
// local alias of them (`const body = await request.json()`, `const { title } = data`).
//
// Deliberately conservative: a match yields `precise`; no match yields `heuristic` (the input and sink
// merely co-occur). It never claims a flow it didn't see, which is the point — a consumer pinning a
// rule to a parameter should trust `precise` and treat `heuristic` as "may reach".
function linkFlows(
  bodyNode: any,
  params: any,
  inputs: InputField[],
  sinks: Sink[],
  ts: TsModule,
): Flow[] {
  if (!bodyNode || sinks.length === 0 || inputs.length === 0) return [];
  const taintedRoots = new Set<string>();
  for (const p of params ?? []) {
    if (!p?.name) continue;
    if (ts.isIdentifier(p.name)) taintedRoots.add(p.name.text);
    else if (ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) taintedRoots.add(el.name.text);
    }
  }
  // Local aliases of tainted data: `const body = await request.json()`, `const { title } = data`.
  const aliasVisit = (n: any) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const root = rootIdentifier(n.initializer, ts);
      const fromTainted = root ? taintedRoots.has(root) : false;
      const isRequestRead = /\b(json|formData|text|body|query|params)\b/.test(n.initializer.getText?.() ?? '');
      if (fromTainted || isRequestRead) {
        if (ts.isIdentifier(n.name)) taintedRoots.add(n.name.text);
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) taintedRoots.add(el.name.text);
        }
      }
    }
    ts.forEachChild(n, aliasVisit);
  };
  aliasVisit(bodyNode);

  // Index sink call sites by line so a sink (which carries `line`) can be matched to its AST node.
  const callsByLine = new Map<number, any[]>();
  const callVisit = (n: any) => {
    if (ts.isCallExpression(n)) {
      const ln = lineOf(n);
      if (ln !== undefined) {
        const list = callsByLine.get(ln) ?? [];
        list.push(n);
        callsByLine.set(ln, list);
      }
    }
    ts.forEachChild(n, callVisit);
  };
  callVisit(bodyNode);

  const flows: Flow[] = [];
  for (const sink of sinks) {
    const candidates = sink.line !== undefined ? (callsByLine.get(sink.line) ?? []) : [];
    // Text of every argument at this sink's call site(s) — where a tainted value would appear.
    let argText = '';
    for (const c of candidates) {
      for (const a of c.arguments ?? []) {
        try { argText += ' ' + a.getText(); } catch { /* ignore */ }
      }
    }
    for (const input of inputs) {
      const leaf = input.name.split('.').pop()!.replace(/\[\]$/, '');
      // `data.title` / `{ title }` / `req.body.title` — the leaf name appearing in the sink's args,
      // qualified by a tainted root when it's a member path.
      const mentionsLeaf = argText.length > 0 && new RegExp(`\\b${escapeRe(leaf)}\\b`).test(argText);
      const mentionsTaintedRoot = [...taintedRoots].some((r) => new RegExp(`\\b${escapeRe(r)}\\b`).test(argText));
      if (mentionsLeaf && (mentionsTaintedRoot || taintedRoots.has(leaf))) {
        flows.push({ input: input.name, sink, confidence: 'precise', line: sink.line });
      } else {
        flows.push({ input: input.name, sink, confidence: 'heuristic', line: sink.line });
      }
    }
  }
  return flows;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localCalls(node: any, ts: TsModule): string[] {
  const names: string[] = [];
  const visit = (n: any) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) names.push(n.expression.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

function dedupeSinks(sinks: Sink[]): Sink[] {
  const seen = new Set<string>();
  const out: Sink[] = [];
  for (const s of sinks) {
    const key = `${s.kind}:${s.provider}:${s.package}:${s.table}:${s.op}:${s.line}`;
    if (!seen.has(key)) { seen.add(key); out.push(s); }
  }
  return out;
}
