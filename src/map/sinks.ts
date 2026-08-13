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
// Drivers that are not in the inference list above but do establish a database API when a receiver
// resolves to them. Extend deliberately: this list is what separates "a package we can trace" from
// "a package that proves a DB API", and admitting the wrong one produces a false SQL-injection rule.
const MORE_DB_PACKAGES = ['postgres', 'mssql', 'tedious', 'oracledb', 'sqlite3', 'mongodb', 'ioredis',
  '@planetscale/database', '@neondatabase/serverless', '@libsql/client', '@vercel/postgres', 'slonik', 'sql.js'];
/**
 * Does `pkg` establish a DATABASE api? Package provenance is not API provenance: `.query()` is a generic
 * method name, and an `@apollo/client` (or any HTTP-ish client) instance resolves to a real package while
 * having nothing to do with SQL. Without this gate, `client.query(req.body.sql)` compiled a precise
 * SQL-injection candidate for a GraphQL call — a rule that blocks legitimate traffic and mitigates nothing.
 * Subpath imports count (`drizzle-orm/node-postgres`).
 */
const isDbPackage = (pkg: string) =>
  DB_PACKAGES.includes(pkg) || MORE_DB_PACKAGES.includes(pkg) ||
  [...DB_PACKAGES, ...MORE_DB_PACKAGES].some((p) => pkg.startsWith(p + '/'));
const HTTP_PACKAGES = ['axios', 'got', 'node-fetch', 'undici', 'superagent', 'ky'];
const isHttpPackage = (pkg: string) => HTTP_PACKAGES.includes(pkg) || pkg === 'node:http' || pkg === 'node:https';
// A filesystem/process API is not only a node: builtin — these wrappers expose the same sinks, and
// requiring a match keeps recognition tied to a RESOLVED import rather than to a method name.
const FS_PACKAGES = ['fs-extra', 'graceful-fs', 'memfs'];
const isFsPackage = (pkg: string) => /^node:fs(\/promises)?$/.test(pkg) || FS_PACKAGES.includes(pkg);
const EXEC_PACKAGES = ['execa', 'cross-spawn', 'shelljs', 'zx'];
const isExecPackage = (pkg: string) => pkg === 'node:child_process' || EXEC_PACKAGES.includes(pkg);

export interface ModuleGraph {
  /** Sinks of `exportName` in the module `specifier` resolves to, relative to `fromFile`. */
  importedSinks(fromFile: string, specifier: string, exportName: string): Sink[];
  /**
   * The npm package `exportName` traces to inside the module `specifier` resolves to — for a client
   * instance re-exported from a local module (`export const db = createClient(...)`). ONE hop: a
   * re-export chain (`export { db } from './client'`) is not followed.
   */
  importedPackage(fromFile: string, specifier: string, exportName: string): string | undefined;
}

export interface SinkContext {
  /** Absolute path of the file being analyzed (for resolving relative imports). */
  file: string;
  /** The same file, REPO-RELATIVE — part of a sink's identity, so it must not vary by machine. */
  owner: string;
  graph: ModuleGraph;
}

// --- sinks (agnostic) -------------------------------------------------------
export function collectLocalSinks(sf: any, ts: TsModule, bindings: Bindings, ctx?: SinkContext): Map<string, Sink[]> {
  const map = new Map<string, Sink[]>();
  const visit = (node: any) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) map.set(node.name.text, directSinks(node.body, ts, bindings, ctx));
    else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && isFnLike(decl.initializer, ts)) {
          map.set(decl.name.text, directSinks(decl.initializer.body, ts, bindings, ctx));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

export function sinksFrom(arrowOrNode: any, ts: TsModule, localSinks: Map<string, Sink[]>, bindings: Bindings, ctx?: SinkContext): Sink[] {
  if (!arrowOrNode) return [];
  const body = arrowOrNode.isSyntheticBody ? arrowOrNode.body
    : isFnLike(arrowOrNode, ts) ? arrowOrNode.body : arrowOrNode;
  if (!body) return [];
  const sinks = directSinks(body, ts, bindings, ctx);
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
  // `import * as helper from './util'; helper.save(x)` — the namespace twin of the imported-helper hop
  // above. `directSinks` correctly refuses to call that receiver a dependency sink, so without this the
  // helper's REAL sinks would vanish with it and the endpoint would look clean. Sinks found this way
  // carry the helper's file, which already bars them from auto-generating a rule (no local call site).
  if (ctx) {
    for (const [root, member] of namespaceMemberCalls(body, ts)) {
      const spec = bindings.resolve(root);
      if (spec && spec.startsWith('.')) {
        for (const s of ctx.graph.importedSinks(ctx.file, spec, member)) sinks.push(s);
      }
    }
  }
  return dedupeSinks(sinks, ctx?.owner ?? '');
}

/** `ns.member(...)` calls in a subtree, as [namespace root, member] pairs. */
function namespaceMemberCalls(node: any, ts: TsModule): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const visit = (n: any) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)) {
      out.push([n.expression.expression.text, n.expression.name.text]);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

// Provider-agnostic sink recognizers over a subtree. Each sink is tagged with the npm package behind
// it: resolved precisely from the call's base identifier via the file's imports, else inferred from
// the file's imports of a known provider for that sink kind. A receiver that traces to a plain local
// object/class/function is NOT a dependency sink and is dropped.
function directSinks(node: any, ts: TsModule, bindings: Bindings, ctx?: SinkContext): Sink[] {
  const sinks: Sink[] = [];
  // `spec` is the raw module specifier the receiver came from, which `pkg` cannot express: a RELATIVE
  // specifier yields no package, and that is a positive fact (the receiver is app code) rather than the
  // absence of one (an untraceable receiver such as a handler param). The member-call recognizers below
  // need that distinction — `import * as helper from './util'; helper.exec(x)` is not child_process.
  const baseOf = (base: any): { pkg?: string; local?: boolean; root?: string; spec?: string; relative?: boolean } => {
    const root = base ? rootIdentifier(base, ts) : undefined;
    if (!root) return {};
    const spec = bindings.resolve(root);
    const relative = spec !== undefined && (spec.startsWith('.') || spec.startsWith('/'));
    const pkg = npmPackageOf(spec);
    if (pkg) return { pkg, root, spec };
    // A RELATIVE receiver is app code — unless one hop away it is a dependency. `import { db } from
    // './lib/db'` where that module does `export const db = createClient(...)` is the most common layout
    // in generated apps, and treating it as app code made the sink vanish entirely. Ask the target module
    // what the export traces to: a package means the receiver IS that dependency (an import-to-import
    // chain, so `attribution: 'import'`), and NO package means it stays app code — which is what keeps
    // `import * as helper from './util'; helper.exec(x)` correctly sink-free.
    if (relative && ctx && spec) {
      const viaModule = ctx.graph.importedPackage(ctx.file, spec, bindings.exportNameOf(root) ?? root);
      if (viaModule) return { pkg: viaModule, root, spec };
    }
    return { local: bindings.locals.has(root), root, spec, relative };
  };
  // Whether `package` is evidence or a guess. A resolved import binding is evidence ('import'); a
  // package inferred from the file's OTHER imports is a guess that is usually right ('inferred'); an
  // untraceable receiver is neither (undefined) and must not drive an auto-generated rule.
  const attributionOf = (b: { pkg?: string }, pkg: string | undefined): Sink['attribution'] =>
    b.pkg ? 'import' : pkg ? 'inferred' : undefined;
  /**
   * Claim `provider: 'sql'` only when the package actually establishes a database API. A traced package
   * that is not a DB provider stays in the INVENTORY (a `.query()` on it is worth a human's attention)
   * but is marked so no rule can be compiled from it — and it does not get to call itself SQL.
   */
  const dbApi = (pkg: string | undefined): { provider?: string; apiUnconfirmed?: true } =>
    pkg && !isDbPackage(pkg) ? { apiUnconfirmed: true } : { provider: 'sql' };
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
        if (!b.local && !b.relative && parent && ts.isPropertyAccessExpression(parent) && DB_OPS.has(parent.name.text)) {
          const pkg = b.pkg ?? infer('db');
          push({ kind: 'db', ...dbApi(pkg), package: pkg, table, op: parent.name.text, attribution: attributionOf(b, pkg), ...spanOf(opCallOf(parent, ts)) });
        }
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const b = baseOf(callee.expression);
        // `!b.relative` is the member-call twin of the bare-call justification below: a receiver that
        // resolves to a RELATIVE module is app code, whatever its methods are named. Without it,
        // `import * as helper from './util'; helper.exec(req.body.cmd)` was read as child_process and
        // produced a proven, auto-generatable command-injection candidate for harmless local code.
        // Such a receiver is not dropped outright — `sinksFrom` follows it into its module instead.
        if (!b.local && !b.relative) {
          // db: prisma-style `prisma.<model>.<op>()` — the op names are generic (`delete`, `update`, …),
          // so require a real prisma signal: a resolved binding, the import, or a prisma-named receiver.
          if (PRISMA_OPS.has(method) && ts.isPropertyAccessExpression(callee.expression)) {
            const prismaLikely = b.pkg === '@prisma/client' ||
              (!b.pkg && (bindings.imports.has('@prisma/client') || /prisma/i.test(b.root ?? '')));
            if (prismaLikely) push({ kind: 'db', provider: 'prisma', package: '@prisma/client', table: callee.expression.name.text, op: method, attribution: b.pkg ? 'import' : 'inferred', ...spanOf(n) });
          }
          // db: raw `.query(` / `.execute(`. Any object can have a `.query` method, so an untraceable
          // receiver stays in the inventory with NO attribution — visible to a human, never auto-ruled.
          if (method === 'query' || method === 'execute') {
            const pkg = b.pkg ?? infer('db');
            push({ kind: 'db', ...dbApi(pkg), package: pkg, op: method, attribution: attributionOf(b, pkg), ...spanOf(n) });
          }
          // fs / exec via a namespace: `fs.writeFile(` / `child_process.exec(`. The receiver must
          // actually resolve to a filesystem/process package — the method name alone proves nothing.
          if (FS_CALLS.test(method) && b.pkg && isFsPackage(b.pkg)) {
            push({ kind: 'fs', package: b.pkg, op: method, attribution: 'import', ...spanOf(n) });
          }
          if (EXEC_CALLS.test(method) && b.pkg && isExecPackage(b.pkg)) {
            push({ kind: 'exec', package: b.pkg, op: method, attribution: 'import', ...spanOf(n) });
          }
          // http: any client whose binding resolves to a known http package (`axios.get`, `ky.post`,
          // `http.request`), else the classic identifiers by name as a heuristic.
          if (HTTP_MEMBER_METHODS.has(method)) {
            if (b.pkg && isHttpPackage(b.pkg)) {
              push({ kind: 'http', provider: b.root, package: b.pkg, op: method, attribution: 'import', ...spanOf(n) });
            } else if (!b.spec && ts.isIdentifier(callee.expression) && /^(axios|http|https|got|ky)$/.test(callee.expression.text)) {
              push({ kind: 'http', provider: callee.expression.text, package: infer('http'), op: method, attribution: 'inferred', ...spanOf(n) });
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
          if (pkg && isHttpPackage(pkg)) push({ kind: 'http', provider: name, package: pkg, op: 'request', attribution: 'import', ...spanOf(n) });
          else if (name === 'fetch' && trueGlobal) push({ kind: 'http', provider: 'fetch', op: 'request', attribution: 'global', ...spanOf(n) });
        }
        // `readFile`/`exec` are never globals: without a matching module binding this is app code.
        if (FS_CALLS.test(name) && pkg && isFsPackage(pkg)) {
          push({ kind: 'fs', package: pkg, op: name, attribution: 'import', ...spanOf(n) });
        }
        if (EXEC_CALLS.test(name) && pkg && isExecPackage(pkg)) {
          push({ kind: 'exec', package: pkg, op: name, attribution: 'import', ...spanOf(n) });
        }
        if (name === 'eval' && trueGlobal) push({ kind: 'eval', op: 'eval', attribution: 'global', ...spanOf(n) });
      }
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Function'
        && !bindings.locals.has('Function') && !isShadowedByEnclosingBinding(n, 'Function', ts)) {
      push({ kind: 'eval', op: 'new Function', attribution: 'global', ...spanOf(n) });
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
// inventory entry without deep-equality. `owner` is the endpoint's own repo-relative file, which the
// span alone does NOT imply: duplicated route boilerplate across two files puts the same call at the
// same offsets, and hashing only the span made those sinks share an id while the schema promises
// map-wide identity. A repo-relative path (never absolute) keeps the id stable across machines.
function sinkId(s: Sink, owner: string): string {
  return createHash('sha256')
    .update([s.kind, s.provider, s.package, s.table, s.op, s.file ?? owner, s.start, s.end].join('|'))
    .digest('hex')
    .slice(0, 12);
}

function dedupeSinks(sinks: Sink[], owner: string): Sink[] {
  const seen = new Set<string>();
  const out: Sink[] = [];
  for (const s of sinks) {
    const key = `${s.kind}:${s.provider}:${s.package}:${s.table}:${s.op}:${s.line}:${s.start}`;
    if (!seen.has(key)) { seen.add(key); out.push({ ...s, id: sinkId(s, owner) }); }
  }
  return out;
}
