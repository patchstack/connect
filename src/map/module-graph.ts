import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import type { Sink, TsModule } from './types.js';
import { guessScriptKind, isFnLike, localCalls } from './ast.js';
import { buildModuleBindings } from './bindings.js';
import { isInside } from './sources.js';
import { collectLocalSinks, type ModuleGraph } from './sinks.js';

// --- cross-file (imported) helper tracing -----------------------------------
// AI-generated apps routinely put the data access in a sibling module (`import { saveOrder } from
// './db'`), so a handler's real sink lives one file away. Without following that, the endpoint looks
// sink-free and no rule can be correlated to it. We follow ONE cross-file hop (plus same-file helpers
// inside the target), which covers the common shape while keeping the walk bounded and cheap.
const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function createModuleGraph(ts: TsModule, opts: { cwd: string; boundary: string; followOutside?: boolean }): ModuleGraph {
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
      // Stay inside the project: `../../other-repo/db` (or a symlink) would otherwise pull an unrelated
      // codebase into this app's attack surface. The primary walker enforces this; so must the resolver.
      if (!opts.followOutside) {
        let real = target;
        try { real = realpathSync(target); } catch { /* use as-is */ }
        if (!isInside(real, opts.boundary)) return [];
      }
      const mod = load(target);
      if (!mod) return [];
      const collected = [...(mod.fnSinks.get(exportName) ?? [])];
      // One same-file hop inside the target: `export function saveOrder(){ return doInsert() }`.
      for (const callee of mod.calleesOf.get(exportName) ?? []) {
        for (const s of mod.fnSinks.get(callee) ?? []) collected.push(s);
      }
      // `line` refers to the HELPER's file, not the endpoint's — carry the file so the coordinate is
      // interpretable (and so flow linking marks it `imported` rather than proven — it cannot see the call).
      const rel = relative(opts.cwd, target);
      return collected.map((s) => ({ ...s, file: rel }));
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
