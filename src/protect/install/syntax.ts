import { createRequire } from 'node:module';
import { join } from 'node:path';
import type tsType from 'typescript';

export type Compiler = typeof tsType;

/** Resolve a parser without evaluating application source or configuration. */
export function sourceCompiler(cwd: string): Compiler | null {
  for (const base of [join(cwd, 'package.json'), import.meta.url]) {
    try { return createRequire(base)('typescript') as Compiler; } catch { /* optional compiler */ }
  }
  return null;
}

export function parsedSource(ts: Compiler, file: string, source: string) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return (tree as typeof tree & { parseDiagnostics: unknown[] }).parseDiagnostics.length ? null : tree;
}

/** A complete statement, not the first line of an import, call, or declaration. */
export function statementEndLine(ts: Compiler, file: string, source: string, line: number): number | null {
  const tree = parsedSource(ts, file, source);
  if (!tree) return null;
  let end: number | null = null;
  const visit = (node: tsType.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isVariableStatement(node) || ts.isExpressionStatement(node))
      && tree.getLineAndCharacterOfPosition(node.getStart(tree)).line === line) {
      const tail = source.slice(node.end).split('\n', 1)[0]!.trim();
      if (tail !== '' && !tail.startsWith('//')) return;
      end = tree.getLineAndCharacterOfPosition(node.end).line;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return end;
}

/** Locate a single matching statement, including inside a compact bootstrap function. */
export function statementPosition(ts: Compiler, file: string, source: string, line: number, matches: RegExp): {start: number; end: number} | null {
  const tree = parsedSource(ts, file, source);
  if (!tree) return null;
  const statements: {start: number; end: number}[] = [];
  const visit = (node: tsType.Node) => {
    if ((ts.isVariableStatement(node) || ts.isExpressionStatement(node))
      && tree.getLineAndCharacterOfPosition(node.getStart(tree)).line === line
      && matches.test(node.getText(tree))) statements.push({start: node.getStart(tree), end: node.end});
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return statements.length === 1 ? statements[0]! : null;
}
