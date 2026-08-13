import { createHash } from 'node:crypto';
import type { ArgumentRole, CandidateFamily, Sink, TsModule } from './types.js';
import {
  isFnLike,
  isShadowedByEnclosingBinding,
  isUninvokedFunctionDeclaration,
  localCalls,
  opCallOf,
  rootIdentifier,
  spanOf,
} from './ast.js';
import { npmPackageOf, type Bindings } from './bindings.js';

const DB_OPS = new Set(['insert', 'update', 'delete', 'select', 'upsert', 'rpc']);
const PRISMA_OPS = new Set(['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert', 'findFirst', 'findUnique', 'findMany', 'count', 'aggregate']);
const FS_CALLS = /^(readFile|writeFile|readFileSync|writeFileSync|appendFile|createReadStream|createWriteStream|unlink|rm|rmSync|mkdir|readdir|stat|open)$/;
const EXEC_CALLS = /^(exec|execSync|spawn|spawnSync|execFile|execFileSync|fork)$/;
const HTTP_CALLS = /^(fetch|got|request)$/;
const HTTP_MEMBER_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'request']);
// When a sink's base can't be traced precisely, infer its package from the file's imports of a known
// provider for that sink kind (a file almost always uses one db/http client).
const DB_PACKAGES = ['@supabase/supabase-js', '@prisma/client', 'drizzle-orm', 'knex', 'kysely', 'pg', 'mysql2', 'mysql', 'sequelize', 'typeorm', 'mongoose', 'better-sqlite3'];
const HTTP_PACKAGES = ['axios', 'got', 'node-fetch', 'undici', 'superagent', 'ky'];
const isHttpPackage = (pkg: string) => HTTP_PACKAGES.includes(pkg) || pkg === 'node:http' || pkg === 'node:https';

export interface ModuleGraph {
  /** Sinks of `exportName` in the module `specifier` resolves to, relative to `fromFile`. */
  importedSinks(fromFile: string, specifier: string, exportName: string): Sink[];
}

// --- sinks (agnostic) -------------------------------------------------------
export function collectLocalSinks(sf: any, ts: TsModule, bindings: Bindings): Map<string, Sink[]> {
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

export function sinksFrom(arrowOrNode: any, ts: TsModule, localSinks: Map<string, Sink[]>, bindings: Bindings, ctx?: { file: string; graph: ModuleGraph }): Sink[] {
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
        for (const s of ctx.graph.importedSinks(ctx.file, spec, bindings.exportNameOf(called) ?? called)) sinks.push(s);
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
          push({ kind: 'db', provider: 'sql', package: b.pkg ?? infer('db'), table, op: parent.name.text, ...spanOf(opCallOf(parent, ts)) });
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
            if (prismaLikely) push({ kind: 'db', provider: 'prisma', package: '@prisma/client', table: callee.expression.name.text, op: method, ...spanOf(n) });
          }
          // db: raw `.query(` / `.execute(`
          if (method === 'query' || method === 'execute') {
            push({ kind: 'db', provider: 'sql', package: b.pkg ?? infer('db'), op: method, ...spanOf(n) });
          }
          // fs / exec via a namespace: `fs.writeFile(` / `child_process.exec(`
          if (FS_CALLS.test(method)) push({ kind: 'fs', package: b.pkg, op: method, ...spanOf(n) });
          if (EXEC_CALLS.test(method)) push({ kind: 'exec', package: b.pkg, op: method, ...spanOf(n) });
          // http: any client whose binding resolves to a known http package (`axios.get`, `ky.post`,
          // `http.request`), else the classic identifiers by name as a heuristic.
          if (HTTP_MEMBER_METHODS.has(method)) {
            if (b.pkg && isHttpPackage(b.pkg)) {
              push({ kind: 'http', provider: b.root, package: b.pkg, op: method, ...spanOf(n) });
            } else if (!b.pkg && ts.isIdentifier(callee.expression) && /^(axios|http|https|got|ky)$/.test(callee.expression.text)) {
              push({ kind: 'http', provider: callee.expression.text, package: infer('http'), op: method, ...spanOf(n) });
            }
          }
        }
      }
      // Bare calls: `fetch(…)` / `exec(…)` / `readFile(…)` / `eval(…)`. A dangerous NAME is not a
      // dangerous API: `import { fetch } from './util'` and a callback parameter named `fetch` both look
      // identical here, and treating either as an HTTP request produced a FALSE SSRF candidate. So the
      // call must be justified — either it resolves to a module that plausibly provides that API, or it
      // is a genuine unresolved global (only `fetch`/`eval`/`Function` ever are).
      if (ts.isIdentifier(callee) && !bindings.locals.has(callee.text)) {
        const name = callee.text;
        const spec = bindings.resolve(name);
        const pkg = npmPackageOf(spec);
        const shadowed = isShadowedByEnclosingBinding(n, name, ts);
        // A relative import resolves to no package: it's app code, not the API it shares a name with.
        const fromModule = spec !== undefined;
        const trueGlobal = !fromModule && !shadowed;

        if (HTTP_CALLS.test(name)) {
          if (pkg && isHttpPackage(pkg)) push({ kind: 'http', provider: name, package: pkg, op: 'request', ...spanOf(n) });
          else if (name === 'fetch' && trueGlobal) push({ kind: 'http', provider: 'fetch', op: 'request', ...spanOf(n) });
        }
        // `readFile`/`exec` are never globals: without a matching module binding this is app code.
        if (FS_CALLS.test(name) && pkg && /^node:fs(\/promises)?$/.test(pkg)) {
          push({ kind: 'fs', package: pkg, op: name, ...spanOf(n) });
        }
        if (EXEC_CALLS.test(name) && pkg === 'node:child_process') {
          push({ kind: 'exec', package: pkg, op: name, ...spanOf(n) });
        }
        if (name === 'eval' && trueGlobal) push({ kind: 'eval', op: 'eval', ...spanOf(n) });
      }
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Function'
        && !bindings.locals.has('Function') && !isShadowedByEnclosingBinding(n, 'Function', ts)) {
      push({ kind: 'eval', op: 'new Function', ...spanOf(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return sinks;
}

// --- adapter summaries: which argument means what ---------------------------
// Small, testable per-library summaries, keyed by sink kind so an overloaded name (`get`) can't be read
// as the wrong thing. This is the cheap foundation the review recommended BEFORE a whole-program
// dataflow engine: without argument roles, "the input reaches this sink" cannot be turned into a rule,
// because the mitigation class depends on WHICH argument received the value.
const ARGUMENT_ROLES: Record<string, Record<string, ArgumentRole[]>> = {
  exec: {
    exec: ['command'], execSync: ['command'],
    execFile: ['file', 'args'], execFileSync: ['file', 'args'],
    spawn: ['command', 'args'], spawnSync: ['command', 'args'], fork: ['file', 'args'],
  },
  http: {
    fetch: ['url', 'init'], request: ['url', 'options'],
    get: ['url', 'options'], head: ['url', 'options'], delete: ['url', 'options'],
    post: ['url', 'body'], put: ['url', 'body'], patch: ['url', 'body'],
  },
  fs: {
    readFile: ['path'], readFileSync: ['path'], open: ['path'],
    writeFile: ['path', 'content'], writeFileSync: ['path', 'content'],
    appendFile: ['path', 'content'],
    unlink: ['path'], rm: ['path'], rmSync: ['path'], mkdir: ['path'], readdir: ['path'], stat: ['path'],
    createReadStream: ['path'], createWriteStream: ['path'],
  },
  db: {
    query: ['sql', 'values'], execute: ['sql', 'values'],
    insert: ['values'], update: ['values'], upsert: ['values'], select: ['columns'],
    // Filters: the value half is still request data reaching the query, but as a bound parameter.
    eq: ['column', 'value'], neq: ['column', 'value'], gt: ['column', 'value'], gte: ['column', 'value'],
    lt: ['column', 'value'], lte: ['column', 'value'], like: ['column', 'value'], ilike: ['column', 'value'],
    match: ['values'], filter: ['column', 'value'],
  },
  eval: { eval: ['code'], Function: ['code'] },
};

/**
 * The (sink kind, argument role) pairs where a request value arriving is inherently dangerous AND a rule
 * can express the mitigation. Deliberately narrow — notably `db`+`values` is absent: a request value in
 * a parameterized insert is genuine reachability signal but not a blockable pattern by itself.
 */
export const CANDIDATE_FAMILIES: Record<string, Partial<Record<ArgumentRole, CandidateFamily>>> = {
  http: { url: 'ssrf' },
  exec: { command: 'command-injection', file: 'command-injection', args: 'command-injection' },
  fs: { path: 'path-traversal' },
  db: { sql: 'sql-injection' },
  eval: { code: 'code-injection' },
};

/** Role of argument `index` for this call, given the sink kind it was recognized as. */
export function argumentRoleOf(sinkKind: string, method: string | undefined, index: number, total = 0): ArgumentRole {
  // `new Function(a, b, "return a+b")` — every argument but the LAST declares a parameter name; only the
  // last one is executable code. An index-based table cannot express that.
  if (sinkKind === 'eval' && method === 'Function') return index === total - 1 ? 'code' : 'args';
  const table = method ? ARGUMENT_ROLES[sinkKind]?.[method] : undefined;
  return table?.[index] ?? 'unknown';
}

// Deterministic identity for a sink, so `Flow.sink` (an embedded copy) can be correlated back to the
// inventory entry without deep-equality.
function sinkId(s: Sink): string {
  return createHash('sha256')
    .update([s.kind, s.provider, s.package, s.table, s.op, s.file, s.start, s.end].join('|'))
    .digest('hex')
    .slice(0, 12);
}

function dedupeSinks(sinks: Sink[]): Sink[] {
  const seen = new Set<string>();
  const out: Sink[] = [];
  for (const s of sinks) {
    const key = `${s.kind}:${s.provider}:${s.package}:${s.table}:${s.op}:${s.line}:${s.start}`;
    if (!seen.has(key)) { seen.add(key); out.push({ ...s, id: sinkId(s) }); }
  }
  return out;
}
