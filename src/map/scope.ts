import type { TsModule } from './types.js';

// Lexical binding resolution without a type checker: which declaration does an identifier refer to?
//
// A name is not an identity. `const cmd = 'ls'` and a block-scoped `const cmd = body.cmd` are different
// bindings, and so are a handler's `request` parameter and an inner callback's own `request`. Keying
// taint or helper lookups by name lets one stand in for the other. This walks the enclosing scopes of
// an occurrence — nearest first — and returns the identifier node that declares it, or `undefined` for
// a name with no declaration in the file (a global, or an ambient one).
//
// Bounded: each scope's declared names are collected once (cached per scope node), and a lookup walks
// only the occurrence's ancestors.

const scopeCache = new WeakMap<object, Map<string, any>>();

/** The identifier node that declares the binding `id` refers to, or undefined when none is in scope. */
export function declarationOf(id: any, ts: TsModule): any | undefined {
  if (!id || !ts.isIdentifier(id)) return undefined;
  const name = id.text;
  for (let cur = id.parent; cur; cur = cur.parent) {
    const declared = declaredIn(cur, ts);
    if (declared?.has(name)) return declared.get(name);
  }
  return undefined;
}

/** Whether `id` refers to the binding declared by `declaration`. */
export function refersTo(id: any, declaration: any, ts: TsModule): boolean {
  return declaration !== undefined && declarationOf(id, ts) === declaration;
}

/** Whether `node` names the global `name` (`URL`, `globalThis.URL`) rather than a binding of that name. */
export function isGlobal(node: any, name: string, ts: TsModule): boolean {
  if (ts.isIdentifier(node)) return node.text === name && declarationOf(node, ts) === undefined;
  return ts.isPropertyAccessExpression(node) && node.name.text === name && ts.isIdentifier(node.expression)
    && node.expression.text === 'globalThis' && declarationOf(node.expression, ts) === undefined;
}

/** The identifier nodes a binding name (`x`, `{ a, b: c }`, `[d, ...e]`) declares. */
export function boundIdentifiers(name: any, ts: TsModule): any[] {
  if (!name) return [];
  if (ts.isIdentifier(name)) return [name];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((el: any) => (ts.isBindingElement(el) ? boundIdentifiers(el.name, ts) : []));
  }
  return [];
}

function isFunctionScope(n: any, ts: TsModule): boolean {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
    || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n)
    || ts.isSetAccessorDeclaration(n) || ts.isSourceFile(n);
}

/** Names declared directly by scope node `n` (undefined when `n` opens no scope). */
function declaredIn(n: any, ts: TsModule): Map<string, any> | undefined {
  const cached = scopeCache.get(n);
  if (cached) return cached;
  const out = new Map<string, any>();
  const add = (ids: any[]) => { for (const i of ids) if (!out.has(i.text)) out.set(i.text, i); };

  if (isFunctionScope(n, ts)) {
    // A function expression's own name is visible inside it.
    if ((ts.isFunctionExpression(n) || ts.isClassExpression?.(n)) && n.name) add([n.name]);
    for (const p of n.parameters ?? []) add(boundIdentifiers(p.name, ts));
    // `var` and nested function declarations are function-scoped wherever they appear in its body.
    collectVarScoped(ts.isSourceFile(n) ? n : n.body, ts, add);
    if (ts.isSourceFile(n)) collectLexical(n.statements, ts, add, true);
  } else if (ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseBlock(n)) {
    const statements = ts.isCaseBlock(n) ? n.clauses.flatMap((c: any) => [...c.statements]) : n.statements;
    collectLexical(statements, ts, add, false);
  } else if (ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) {
    const init = n.initializer;
    if (init && ts.isVariableDeclarationList(init) && isLexicalList(init, ts)) {
      for (const d of init.declarations) add(boundIdentifiers(d.name, ts));
    }
  } else if (ts.isCatchClause(n)) {
    if (n.variableDeclaration) add(boundIdentifiers(n.variableDeclaration.name, ts));
  } else if (ts.isClassExpression?.(n) && n.name) {
    add([n.name]);
  } else {
    return undefined;
  }
  scopeCache.set(n, out);
  return out;
}

function isLexicalList(list: any, ts: TsModule): boolean {
  return (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
}

/** `let` / `const` / class / function declarations and imports that sit directly in a statement list. */
function collectLexical(statements: readonly any[], ts: TsModule, add: (ids: any[]) => void, topLevel: boolean): void {
  for (const s of statements ?? []) {
    if (ts.isVariableStatement(s) && isLexicalList(s.declarationList, ts)) {
      for (const d of s.declarationList.declarations) add(boundIdentifiers(d.name, ts));
    } else if ((ts.isClassDeclaration(s) || ts.isFunctionDeclaration(s) || ts.isEnumDeclaration(s)) && s.name) {
      add([s.name]);
    } else if (topLevel && ts.isImportDeclaration(s) && s.importClause) {
      const clause = s.importClause;
      if (clause.name) add([clause.name]);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) add([bindings.name]);
      if (bindings && ts.isNamedImports(bindings)) add(bindings.elements.map((e: any) => e.name));
    } else if (topLevel && ts.isImportEqualsDeclaration(s)) {
      add([s.name]);
    }
  }
}

/** `var` declarations anywhere in a function body, without entering nested functions. */
function collectVarScoped(node: any, ts: TsModule, add: (ids: any[]) => void): void {
  const visit = (n: any) => {
    if (!n) return;
    if (ts.isVariableDeclarationList(n) && !isLexicalList(n, ts)) {
      for (const d of n.declarations) add(boundIdentifiers(d.name, ts));
    }
    if (n !== node && isFunctionScope(n, ts)) return;
    if (ts.isClassDeclaration(n) || ts.isClassExpression?.(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(node);
}
