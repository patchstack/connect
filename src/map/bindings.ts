import { builtinModules } from 'node:module';
import type { TsModule } from './types.js';
import { isFnLike, isUninvokedFunctionDeclaration, rootIdentifier } from './ast.js';

const BUILTINS = new Set(builtinModules);

// Per-file module bindings: resolve a local identifier to the npm package (or node: builtin) it came
// from — directly (an import), or via `const x = <importedFn|new ImportedClass>(...)` /
// `const x = require('mod')`; derived names resolve transitively (`const conn = pool.promise()`).
// `imports` is every module specifier the file imports (for the fallback). `locals` is every name
// declared in-file that does NOT trace to a module — calls on those receivers are not dependency
// sinks. (Names assigned outside their declaration, e.g. `let fs; fs = require('fs')`, are treated
// as local — an accepted miss.)
export interface Bindings {
  resolve(name: string): string | undefined;
  /** For `import { saveOrder as write }`, maps the local name back to the EXPORTED name. */
  exportNameOf(name: string): string | undefined;
  /**
   * HOW a name reached its package: `direct` from an import/require declaration, `factory` through a
   * traced call chain (`const db = createClient(...)`, `const conn = pool.promise()`).
   *
   * Recorded rather than inferred because the API inventory reports it as evidence: "this call is on a
   * value we followed through a factory" is a weaker claim than "this call is on an imported binding",
   * and a consumer deciding what to act on needs to tell them apart.
   */
  originOf(name: string): 'direct' | 'factory' | undefined;
  imports: Set<string>;
  locals: Set<string>;
}
export function buildModuleBindings(sf: any, ts: TsModule): Bindings {
  const nameToModule = new Map<string, string>(); // local name → module specifier
  const declared = new Set<string>(); // every name declared in this file
  const exportNames = new Map<string, string>(); // local alias → exported name
  const imports = new Set<string>();
  const origins = new Map<string, 'direct' | 'factory'>();

  const record = (local: string, mod: string, origin: 'direct' | 'factory' = 'direct') => {
    nameToModule.set(local, mod);
    imports.add(mod);
    if (!origins.has(local)) origins.set(local, origin);
  };
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
        else if (ts.isNamedImports(nb)) for (const el of nb.elements) {
          record(el.name.text, mod);
          // `import { saveOrder as write }` — looking up `write` in the target module would miss.
          if (el.propertyName && ts.isIdentifier(el.propertyName)) exportNames.set(el.name.text, el.propertyName.text);
        }
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
            if (nameToModule.has(root)) record(decl.name.text, nameToModule.get(root)!, 'factory');
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
      if (!nameToModule.has(name) && nameToModule.has(root)) { record(name, nameToModule.get(root)!, 'factory'); changed = true; }
    }
    if (!changed) break;
  }
  const locals = new Set([...declared].filter((n) => !nameToModule.has(n)));
  return {
    resolve: (name: string) => nameToModule.get(name),
    exportNameOf: (name: string) => exportNames.get(name),
    originOf: (name: string) => origins.get(name),
    imports,
    locals,
  };
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

// Normalize a module specifier to its npm package root (keep scope, drop subpath). Node builtins are
// normalized to the `node:` form even when imported bare (`import fs from 'fs'`) — there IS an npm
// package named `fs`, and CVE correlation must never confuse the two. Relative paths → undefined.
export function npmPackageOf(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  if (spec.startsWith('.') || spec.startsWith('/')) return undefined;
  if (spec.startsWith('node:')) return spec;
  if (BUILTINS.has(spec)) return `node:${spec}`;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
