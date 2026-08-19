import type { TsModule } from './types.js';

// Dependency-free AST helpers shared by every recognizer in this directory.

// Leftmost identifier of a member/call chain (`supabase.from(x).insert` → "supabase", `fs.writeFile` → "fs").
// `new` is part of a chain like any other link: `new Pool().query` roots at `Pool`, and so does
// `function getDb() { return new Pool() }` — the shape a generated app uses for a database client. Omitting
// it dropped the receiver entirely, which reads as "not a dependency" rather than "not followed".
export function rootIdentifier(node: any, ts: TsModule): string | undefined {
  let cur = node;
  while (cur) {
    if (ts.isIdentifier(cur)) return cur.text;
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur) || ts.isCallExpression(cur) || ts.isNewExpression(cur) || ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) {
      cur = cur.expression;
    } else return undefined;
  }
  return undefined;
}

// Source span of a node: the auditable coordinate, AND the sink's identity for flow analysis (a line is
// not an identity — two sinks can share one, and an enclosing statement can hold unrelated expressions).
export function spanOf(node: any): { line?: number; start?: number; end?: number } {
  const out: { line?: number; start?: number; end?: number } = { line: lineOf(node) };
  try { out.start = node.getStart(); out.end = node.getEnd(); } catch { /* synthetic node */ }
  return out;
}

// 1-based line of a node in its source file — the auditable coordinate rules and humans point at.
export function lineOf(node: any): number | undefined {
  const sf = typeof node?.getSourceFile === 'function' ? node.getSourceFile() : undefined;
  if (!sf) return undefined;
  try { return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1; } catch { return undefined; }
}

export function guessScriptKind(ts: TsModule, file: string) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function isFnLike(n: any, ts: TsModule): n is import('typescript').ArrowFunction | import('typescript').FunctionExpression {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n);
}
export function hasExport(node: any, ts: TsModule): boolean {
  return Boolean(node.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword));
}

// --- call-chain + method ----------------------------------------------------
export function unwindChain(node: any, ts: TsModule): { baseName?: string; baseCall?: any; calls: Record<string, any> } {
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

export function methodFromObjectArg(baseCall: any, ts: TsModule): string | undefined {
  const arg = baseCall?.arguments?.[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
  for (const p of arg.properties) {
    if (ts.isPropertyAssignment(p) && (p.name as any)?.text === 'method' && ts.isStringLiteralLike(p.initializer)) {
      return p.initializer.text.toUpperCase();
    }
  }
  return undefined;
}

export function bindingKey(el: any, ts: TsModule): string | undefined {
  if (!ts.isBindingElement(el)) return undefined;
  const prop = el.propertyName ?? el.name;
  return prop && ts.isIdentifier(prop) ? prop.text : undefined;
}

// A named function *declaration*, or a function bound to a variable/property — i.e. code that only runs
// if something calls it. An inline callback (an arrow passed as an argument), an IIFE, or a function
// used directly in an expression is NOT this: those execute where they appear.
export function isUninvokedFunctionDeclaration(n: any, ts: TsModule): boolean {
  if (ts.isFunctionDeclaration(n)) return true;
  if (isFnLike(n, ts)) {
    const p = n.parent;
    if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))) return true;
  }
  return false;
}

/**
 * Is `name` bound by an enclosing function parameter (or catch clause) at this call site? If so the call
 * is NOT the global of that name — a callback parameter called `fetch` is the single most likely way to
 * fake an SSRF candidate. Scoped to parameters/catch bindings: cheap, and it covers the shadowing shapes
 * that occur in practice. Erring here loses a candidate rather than inventing one.
 */
export function isShadowedByEnclosingBinding(node: any, name: string, ts: TsModule): boolean {
  for (let cur = node?.parent; cur; cur = cur.parent) {
    if (ts.isCatchClause(cur) && cur.variableDeclaration && ts.isIdentifier(cur.variableDeclaration.name)
        && cur.variableDeclaration.name.text === name) return true;
    const params = (cur as any).parameters;
    if (!params) continue;
    for (const p of params) {
      if (!p?.name) continue;
      if (ts.isIdentifier(p.name) && p.name.text === name) return true;
      if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
        for (const el of p.name.elements) {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name) && el.name.text === name) return true;
        }
      }
    }
  }
  return false;
}

/** Method name a call invokes (`db.from(t).insert(x)` → "insert", `exec(x)` → "exec"). */
export function calleeName(call: any, ts: TsModule): string | undefined {
  const c = call?.expression;
  if (!c) return undefined;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  if (ts.isIdentifier(c)) return c.text; // also covers `new Function(...)`
  return undefined;
}

/** Is this identifier occurrence a VALUE read (rather than a property key, a member name, a binding)? */
export function isValueRead(id: any, ts: TsModule): boolean {
  const p = id.parent;
  if (!p) return true;
  if (ts.isPropertyAssignment(p) && p.name === id) return false; // { title: … } — a key
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false; // x.title — the member name
  if (ts.isBindingElement(p) && p.propertyName === id) return false; // { title: t } — the source key
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === id) return false;
  if (ts.isPropertySignature(p) || ts.isMethodSignature(p)) return false;
  return true; // includes ShorthandPropertyAssignment `{ title }`, which IS a read
}

// From a `.insert` property access, the CallExpression that invokes it — the sink's operation call.
export function opCallOf(propAccess: any, ts: TsModule): any {
  const p = propAccess?.parent;
  return p && ts.isCallExpression(p) && p.expression === propAccess ? p : propAccess;
}

export function localCalls(node: any, ts: TsModule): string[] {
  const names: string[] = [];
  const visit = (n: any) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) names.push(n.expression.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}
