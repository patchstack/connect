import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SiteInputMap, Endpoint, InputField, Sink, TsModule } from './types.js';

// Framework-AGNOSTIC input-flow extractor. It doesn't gate on a specific stack — it walks any JS/TS
// source and applies recognizer tables for (1) entry points, (2) inputs, (3) sinks, so it generalizes
// across builders (TanStack Start, Next, SvelteKit, Express/Fastify/Hono, …) and providers, and
// degrades gracefully (recording what it couldn't see in `coverage.notes`). Add a stack by adding a
// recognizer, not a new adapter.

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ROUTE_REGISTER = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'all', 'head', 'use']);
const DB_OPS = new Set(['insert', 'update', 'delete', 'select', 'upsert', 'rpc']);
const PRISMA_OPS = new Set(['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert', 'findFirst', 'findUnique', 'findMany', 'count', 'aggregate']);
const FS_CALLS = /^(readFile|writeFile|readFileSync|writeFileSync|appendFile|createReadStream|createWriteStream|unlink|rm|rmSync|mkdir|readdir|stat|open)$/;
const EXEC_CALLS = /^(exec|execSync|spawn|spawnSync|execFile|execFileSync|fork)$/;
const HTTP_CALLS = /^(fetch|got|request)$/;
const ZOD_BASE = new Set(['string', 'number', 'boolean', 'array', 'object', 'enum', 'bigint', 'date', 'record']);
// When a sink's base can't be traced precisely, infer its package from the file's imports of a known
// provider for that sink kind (a file almost always uses one db/http client).
const DB_PACKAGES = ['@supabase/supabase-js', '@prisma/client', 'drizzle-orm', 'knex', 'kysely', 'pg', 'mysql2', 'mysql', 'sequelize', 'typeorm', 'mongoose', 'better-sqlite3'];
const HTTP_PACKAGES = ['axios', 'got', 'node-fetch', 'undici', 'superagent', 'ky'];

// Per-file module bindings: resolve a local identifier to the npm package (or node: builtin) it came
// from — directly (an import), or via `const x = <importedFn|new ImportedClass>(...)` /
// `const x = require('mod')`. `imports` is every module specifier the file imports (for the fallback).
interface Bindings {
  resolve(name: string): string | undefined;
  imports: Set<string>;
}
function buildModuleBindings(sf: any, ts: TsModule): Bindings {
  const nameToModule = new Map<string, string>(); // local name → module specifier
  const importedNames = new Map<string, string>(); // imported binding → module (for the const-from-import step)
  const imports = new Set<string>();

  const record = (local: string, mod: string) => { nameToModule.set(local, mod); imports.add(mod); };

  const visit = (node: any) => {
    // import … from 'mod'
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const mod = node.moduleSpecifier.text;
      imports.add(mod);
      const clause = node.importClause;
      if (clause?.name) { record(clause.name.text, mod); importedNames.set(clause.name.text, mod); } // default
      const nb = clause?.namedBindings;
      if (nb) {
        if (ts.isNamespaceImport(nb)) { record(nb.name.text, mod); importedNames.set(nb.name.text, mod); }
        else if (ts.isNamedImports(nb)) for (const el of nb.elements) { record(el.name.text, mod); importedNames.set(el.name.text, mod); }
      }
    }
    // const x = require('mod')  /  const { a } = require('mod')
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const init = decl.initializer;
        const reqMod = requireSpecifier(init, ts);
        if (reqMod) {
          if (ts.isIdentifier(decl.name)) record(decl.name.text, reqMod);
          else if (ts.isObjectBindingPattern(decl.name)) for (const el of decl.name.elements) if (ts.isIdentifier(el.name)) record(el.name.text, reqMod);
        }
        // const x = importedFactory(...)  /  const x = new ImportedClass(...)  → x carries that package
        if (init && ts.isIdentifier(decl.name)) {
          const callee = ts.isCallExpression(init) ? init.expression : ts.isNewExpression(init) ? init.expression : undefined;
          const root = callee ? rootIdentifier(callee, ts) : undefined;
          if (root && importedNames.has(root)) record(decl.name.text, importedNames.get(root)!);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { resolve: (name: string) => nameToModule.get(name), imports };
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

// Normalize a module specifier to its npm package root (keep scope, drop subpath); node: builtins kept
// as-is (they signal a builtin, not an npm CVE); relative paths → undefined (local, not a package).
function npmPackageOf(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  if (spec.startsWith('.') || spec.startsWith('/')) return undefined;
  if (spec.startsWith('node:')) return spec;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export async function extractInputMap(cwd: string, ts: TsModule): Promise<SiteInputMap> {
  const notes: string[] = [];
  const endpoints: Endpoint[] = [];
  const srcDir = join(cwd, 'src');
  const root = existsSync(srcDir) ? srcDir : cwd;

  for (const file of collectSources(root)) {
    const text = readFileSync(file, 'utf8');
    if (!hasEntrySignal(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, guessScriptKind(ts, file));
    const bindings = buildModuleBindings(sf, ts);
    const localSinks = collectLocalSinks(sf, ts, bindings);
    for (const ep of extractFromFile(sf, ts, localSinks, bindings)) {
      endpoints.push({ ...ep, file: relative(cwd, file) });
    }
  }

  notes.push('Static analysis is best-effort — this is the DETECTED surface, not a proof of completeness.');
  notes.push('Sinks are followed one level into same-file helpers; cross-file / dynamic indirection is not traced.');
  notes.push('A sink `package` is resolved from the file’s imports (precise) or inferred from a known provider import; an unresolved package means the backing dependency could not be traced.');
  if (endpoints.length === 0) notes.push('No recognized server-side entry points found under the source root.');

  return { version: 1, framework: detectFramework(cwd), endpoints, coverage: { adapter: 'agnostic-v1', notes } };
}

// Cheap textual pre-filter so we only parse files that could contain an entry point.
function hasEntrySignal(text: string): boolean {
  return (
    text.includes('createServerFn') ||
    /\bexport\s+(async\s+)?(function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(text) ||
    /\.(get|post|put|patch|delete|options|all)\s*\(/.test(text) ||
    text.includes("'use server'") || text.includes('"use server"')
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
  return 'unknown';
}

function guessScriptKind(ts: TsModule, file: string) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function collectSources(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) collectSources(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// --- entry-point recognizers -----------------------------------------------
function extractFromFile(sf: any, ts: TsModule, localSinks: Map<string, Sink[]>, bindings: Bindings): Omit<Endpoint, 'file'>[] {
  const out: Omit<Endpoint, 'file'>[] = [];
  const isServerActionsFile = fileHasUseServer(sf, ts);

  const visit = (node: any) => {
    if (ts.isVariableStatement(node) && hasExport(node, ts)) {
      for (const decl of node.declarationList.declarations) {
        // (1) TanStack Start: `export const NAME = createServerFn({method}).inputValidator(fn).handler(fn)`
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          const chain = unwindChain(decl.initializer, ts);
          if (chain.baseName === 'createServerFn' && ts.isIdentifier(decl.name)) {
            out.push({
              name: decl.name.text,
              entryKind: 'server-fn',
              method: methodFromObjectArg(chain.baseCall, ts),
              inputs: inputsFromValidator(chain.calls['inputValidator'] ?? chain.calls['validator'], ts),
              sinks: sinksFrom(chain.calls['handler']?.arguments?.[0], ts, localSinks, bindings),
            });
            continue;
          }
        }
        // (2b) `export const POST = (req) => …` route handler, or a `'use server'` action arrow.
        if (ts.isIdentifier(decl.name) && decl.initializer && isFnLike(decl.initializer, ts)) {
          if (HTTP_METHODS.has(decl.name.text)) {
            out.push(handlerEntry(decl.name.text, decl.name.text, decl.initializer.parameters, decl.initializer.body, ts, localSinks, bindings));
          } else if (isServerActionsFile) {
            out.push(handlerEntry(decl.name.text, 'server-action', decl.initializer.parameters, decl.initializer.body, ts, localSinks, bindings));
          }
        }
      }
    }

    // (2a) Route handlers / server actions declared as functions.
    if (ts.isFunctionDeclaration(node) && node.name && hasExport(node, ts)) {
      if (HTTP_METHODS.has(node.name.text)) {
        out.push(handlerEntry(node.name.text, node.name.text, node.parameters, node.body, ts, localSinks, bindings));
      } else if (isServerActionsFile || hasUseServerDirective(node, ts)) {
        out.push(handlerEntry(node.name.text, 'server-action', node.parameters, node.body, ts, localSinks, bindings));
      }
    }

    // (3) Route registrations: `app.post('/path', …, handler)` / `router.get('/x', handler)` (Express/Fastify/Hono/Koa)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ROUTE_REGISTER.has(node.expression.name.text)) {
      const args = node.arguments;
      const pathArg = args[0];
      const handler = args[args.length - 1];
      if (pathArg && ts.isStringLiteralLike(pathArg) && handler && isFnLike(handler, ts)) {
        out.push(handlerEntry(pathArg.text, `route-registration`, handler.parameters, handler.body, ts, localSinks, bindings, {
          method: node.expression.name.text.toUpperCase(),
          route: pathArg.text,
        }));
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
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
  extra: { method?: string; route?: string } = {},
): Omit<Endpoint, 'file'> {
  const entryKind = kindLabel === 'route-registration' ? 'route-registration' : kindLabel === 'server-action' ? 'server-action' : 'route-handler';
  return {
    name,
    entryKind,
    method: extra.method ?? (HTTP_METHODS.has(name) ? name : undefined),
    route: extra.route,
    inputs: inputsFromHandler(params, body, ts),
    sinks: sinksFrom({ body, parameters: params, isSyntheticBody: true }, ts, localSinks, bindings),
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
function inputsFromValidator(validatorCall: any, ts: TsModule): InputField[] {
  if (!validatorCall) return [];
  return zodObjectFields(validatorCall, ts);
}

// From a raw handler: zod schema fields it parses, plus request member-accesses (req.body/query/params.X).
function inputsFromHandler(params: any, body: any, ts: TsModule): InputField[] {
  const fields = zodObjectFields(body, ts);
  const names = new Set(fields.map((f) => f.name));
  for (const n of requestMemberAccesses(params, body, ts)) {
    if (!names.has(n)) { names.add(n); fields.push({ name: n }); }
  }
  return fields;
}

// Find the first `z.object({...})` in a subtree and read its fields (name + zod type/constraints).
function zodObjectFields(node: any, ts: TsModule): InputField[] {
  if (!node) return [];
  let objectLiteral: any = null;
  const find = (n: any) => {
    if (objectLiteral || !n) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'object') {
      const arg = n.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) { objectLiteral = arg; return; }
    }
    ts.forEachChild(n, find);
  };
  find(node.body ?? node);
  if (!objectLiteral) return [];
  const fields: InputField[] = [];
  for (const p of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(p) || !p.name) continue;
    const fname = (p.name as any).text;
    if (fname) fields.push({ name: fname, ...zodShape(p.initializer, ts) });
  }
  return fields;
}

function zodShape(node: any, ts: TsModule): Omit<InputField, 'name'> {
  const shape: Omit<InputField, 'name'> = {};
  let cur = node;
  while (cur && ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const method = cur.expression.name.text;
    const arg0 = cur.arguments[0];
    if (ZOD_BASE.has(method) && !shape.type) shape.type = method;
    if (method === 'min' && arg0 && ts.isNumericLiteral(arg0)) shape.min = Number(arg0.text);
    if (method === 'max' && arg0 && ts.isNumericLiteral(arg0)) shape.max = Number(arg0.text);
    if (method === 'optional' || method === 'nullish') shape.optional = true;
    cur = cur.expression.expression;
  }
  return shape;
}

// `req.body.X` / `req.query.X` / `req.params.X` where req is the handler's first param.
function requestMemberAccesses(params: any, body: any, ts: TsModule): string[] {
  const reqName = params?.[0] && ts.isIdentifier(params[0].name) ? params[0].name.text : undefined;
  const out = new Set<string>();
  if (!body) return [];
  const visit = (n: any) => {
    // <req>.<body|query|params>.<field>
    if (ts.isPropertyAccessExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const mid = n.expression;
      if (ts.isIdentifier(mid.expression) && (!reqName || mid.expression.text === reqName) &&
          ['body', 'query', 'params'].includes(mid.name.text)) {
        out.add(n.name.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return [...out];
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

function sinksFrom(arrowOrNode: any, ts: TsModule, localSinks: Map<string, Sink[]>, bindings: Bindings): Sink[] {
  if (!arrowOrNode) return [];
  const body = arrowOrNode.isSyntheticBody ? arrowOrNode.body
    : isFnLike(arrowOrNode, ts) ? arrowOrNode.body : arrowOrNode;
  if (!body) return [];
  const sinks = directSinks(body, ts, bindings);
  for (const called of localCalls(body, ts)) for (const s of localSinks.get(called) ?? []) sinks.push(s);
  return dedupeSinks(sinks);
}

// Provider-agnostic sink recognizers over a subtree. Each sink is tagged with the npm package behind
// it: resolved precisely from the call's base identifier via the file's imports, else inferred from
// the file's imports of a known provider for that sink kind (a file uses one db/http client).
function directSinks(node: any, ts: TsModule, bindings: Bindings): Sink[] {
  const sinks: Sink[] = [];
  const pkgOf = (base: any, kind: string): string | undefined => {
    const root = base ? rootIdentifier(base, ts) : undefined;
    const precise = root ? npmPackageOf(bindings.resolve(root)) : undefined;
    if (precise) return precise;
    const table = kind === 'db' ? DB_PACKAGES : kind === 'http' ? HTTP_PACKAGES : null;
    if (table) for (const p of table) if (bindings.imports.has(p)) return p;
    return undefined;
  };
  const push = (s: Sink) => sinks.push(s);
  const visit = (n: any) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      // db: `.from("t").<op>()` (supabase/knex/kysely)
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'from') {
        const t = n.arguments[0];
        const table = t && ts.isStringLiteralLike(t) ? t.text : undefined;
        const parent = n.parent;
        if (parent && ts.isPropertyAccessExpression(parent) && DB_OPS.has(parent.name.text)) {
          push({ kind: 'db', provider: 'sql', package: pkgOf(callee.expression, 'db'), table, op: parent.name.text });
        }
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        // db: prisma-style `prisma.<model>.<op>()`
        if (PRISMA_OPS.has(method) && ts.isPropertyAccessExpression(callee.expression)) {
          push({ kind: 'db', provider: 'prisma', package: pkgOf(callee.expression, 'db') ?? '@prisma/client', table: callee.expression.name.text, op: method });
        }
        // db: raw `.query(` / `.execute(`
        if (method === 'query' || method === 'execute') push({ kind: 'db', provider: 'sql', package: pkgOf(callee.expression, 'db'), op: method });
        // fs / exec via a namespace: `fs.writeFile(` / `child_process.exec(`
        if (FS_CALLS.test(method)) push({ kind: 'fs', package: pkgOf(callee.expression, 'fs'), op: method });
        if (EXEC_CALLS.test(method)) push({ kind: 'exec', package: pkgOf(callee.expression, 'exec'), op: method });
        // http: `axios.get(` / `http.request(`
        if ((method === 'get' || method === 'post' || method === 'request') && ts.isIdentifier(callee.expression) &&
            /^(axios|http|https|got)$/.test(callee.expression.text)) {
          push({ kind: 'http', provider: callee.expression.text, package: pkgOf(callee.expression, 'http'), op: method });
        }
      }
      // bare calls: fetch( / exec( / readFile( / eval( / new Function
      if (ts.isIdentifier(callee)) {
        const name = callee.text;
        if (HTTP_CALLS.test(name)) push({ kind: 'http', provider: name, package: pkgOf(callee, 'http'), op: 'request' });
        if (FS_CALLS.test(name)) push({ kind: 'fs', package: pkgOf(callee, 'fs'), op: name });
        if (EXEC_CALLS.test(name)) push({ kind: 'exec', package: pkgOf(callee, 'exec'), op: name });
        if (name === 'eval') push({ kind: 'eval', op: 'eval' });
      }
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Function') {
      push({ kind: 'eval', op: 'new Function' });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return sinks;
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
    const key = `${s.kind}:${s.provider}:${s.package}:${s.table}:${s.op}`;
    if (!seen.has(key)) { seen.add(key); out.push(s); }
  }
  return out;
}
