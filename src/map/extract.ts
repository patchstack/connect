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

export async function extractInputMap(cwd: string, ts: TsModule): Promise<SiteInputMap> {
  const notes: string[] = [];
  const endpoints: Endpoint[] = [];
  const srcDir = join(cwd, 'src');
  const root = existsSync(srcDir) ? srcDir : cwd;

  for (const file of collectSources(root)) {
    const text = readFileSync(file, 'utf8');
    if (!hasEntrySignal(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, guessScriptKind(ts, file));
    const localSinks = collectLocalSinks(sf, ts);
    for (const ep of extractFromFile(sf, ts, localSinks)) {
      endpoints.push({ ...ep, file: relative(cwd, file) });
    }
  }

  notes.push('Static analysis is best-effort — this is the DETECTED surface, not a proof of completeness.');
  notes.push('Sinks are followed one level into same-file helpers; cross-file / dynamic indirection is not traced.');
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
function extractFromFile(sf: any, ts: TsModule, localSinks: Map<string, Sink[]>): Omit<Endpoint, 'file'>[] {
  const out: Omit<Endpoint, 'file'>[] = [];

  const visit = (node: any) => {
    // (1) TanStack Start: `export const NAME = createServerFn({method}).inputValidator(fn).handler(fn)`
    if (ts.isVariableStatement(node) && hasExport(node, ts)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          const chain = unwindChain(decl.initializer, ts);
          if (chain.baseName === 'createServerFn' && ts.isIdentifier(decl.name)) {
            out.push({
              name: decl.name.text,
              entryKind: 'server-fn',
              method: methodFromObjectArg(chain.baseCall, ts),
              inputs: inputsFromValidator(chain.calls['inputValidator'] ?? chain.calls['validator'], ts),
              sinks: sinksFrom(chain.calls['handler']?.arguments?.[0], ts, localSinks),
            });
          }
        }
      }
    }

    // (2) Route handlers: `export (async) function GET/POST/…(req)` / `export const POST = (req) => …`
    //     (Next route handlers, SvelteKit +server, etc.)
    if (ts.isFunctionDeclaration(node) && node.name && hasExport(node, ts) && HTTP_METHODS.has(node.name.text)) {
      out.push(handlerEntry(node.name.text, node.name.text, node.parameters, node.body, ts, localSinks));
    }
    if (ts.isVariableStatement(node) && hasExport(node, ts)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && HTTP_METHODS.has(decl.name.text) && decl.initializer && isFnLike(decl.initializer, ts)) {
          out.push(handlerEntry(decl.name.text, decl.name.text, decl.initializer.parameters, decl.initializer.body, ts, localSinks));
        }
      }
    }

    // (3) Route registrations: `app.post('/path', …, handler)` / `router.get('/x', handler)` (Express/Fastify/Hono/Koa)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ROUTE_REGISTER.has(node.expression.name.text)) {
      const args = node.arguments;
      const pathArg = args[0];
      const handler = args[args.length - 1];
      if (pathArg && ts.isStringLiteralLike(pathArg) && handler && isFnLike(handler, ts)) {
        out.push(handlerEntry(pathArg.text, `route-registration`, handler.parameters, handler.body, ts, localSinks, {
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

function handlerEntry(
  name: string,
  kindLabel: string,
  params: any,
  body: any,
  ts: TsModule,
  localSinks: Map<string, Sink[]>,
  extra: { method?: string; route?: string } = {},
): Omit<Endpoint, 'file'> {
  return {
    name,
    entryKind: kindLabel === 'route-registration' ? 'route-registration' : 'route-handler',
    method: extra.method ?? (HTTP_METHODS.has(name) ? name : undefined),
    route: extra.route,
    inputs: inputsFromHandler(params, body, ts),
    sinks: sinksFrom({ body, parameters: params, isSyntheticBody: true }, ts, localSinks),
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
function collectLocalSinks(sf: any, ts: TsModule): Map<string, Sink[]> {
  const map = new Map<string, Sink[]>();
  const visit = (node: any) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) map.set(node.name.text, directSinks(node.body, ts));
    else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && isFnLike(decl.initializer, ts)) {
          map.set(decl.name.text, directSinks(decl.initializer.body, ts));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

function sinksFrom(arrowOrNode: any, ts: TsModule, localSinks: Map<string, Sink[]>): Sink[] {
  if (!arrowOrNode) return [];
  const body = arrowOrNode.isSyntheticBody ? arrowOrNode.body
    : isFnLike(arrowOrNode, ts) ? arrowOrNode.body : arrowOrNode;
  if (!body) return [];
  const sinks = directSinks(body, ts);
  for (const called of localCalls(body, ts)) for (const s of localSinks.get(called) ?? []) sinks.push(s);
  return dedupeSinks(sinks);
}

// Provider-agnostic sink recognizers over a subtree.
function directSinks(node: any, ts: TsModule): Sink[] {
  const sinks: Sink[] = [];
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
          push({ kind: 'db', provider: 'sql', table, op: parent.name.text });
        }
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        // db: prisma-style `prisma.<model>.<op>()`
        if (PRISMA_OPS.has(method) && ts.isPropertyAccessExpression(callee.expression)) {
          push({ kind: 'db', provider: 'prisma', table: callee.expression.name.text, op: method });
        }
        // db: raw `.query(` / `.execute(`
        if (method === 'query' || method === 'execute') push({ kind: 'db', provider: 'sql', op: method });
        // fs / exec via a namespace: `fs.writeFile(` / `child_process.exec(`
        if (FS_CALLS.test(method)) push({ kind: 'fs', op: method });
        if (EXEC_CALLS.test(method)) push({ kind: 'exec', op: method });
        // http: `axios.get(` / `http.request(`
        if ((method === 'get' || method === 'post' || method === 'request') && ts.isIdentifier(callee.expression) &&
            /^(axios|http|https|got)$/.test(callee.expression.text)) {
          push({ kind: 'http', provider: callee.expression.text, op: method });
        }
      }
      // bare calls: fetch( / exec( / readFile( / eval( / new Function
      if (ts.isIdentifier(callee)) {
        const name = callee.text;
        if (HTTP_CALLS.test(name)) push({ kind: 'http', provider: name, op: 'request' });
        if (FS_CALLS.test(name)) push({ kind: 'fs', op: name });
        if (EXEC_CALLS.test(name)) push({ kind: 'exec', op: name });
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
    const key = `${s.kind}:${s.provider}:${s.table}:${s.op}`;
    if (!seen.has(key)) { seen.add(key); out.push(s); }
  }
  return out;
}
