import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parsedSource, sourceCompiler, type Compiler } from './syntax.js';
import { read, templatesDir } from './util.js';

/** Unknown executable helper code requires manual integration, not an automatic import. */
export function matchesGuardTemplate(cwd: string, file: string, template: string): boolean {
  if (!existsSync(join(cwd, file))) return false;
  const ts = sourceCompiler(cwd);
  if (!ts) return false;
  const actual = canonical(ts, file, read(join(cwd, file)));
  const expected = canonical(ts, template, read(join(templatesDir(), template)));
  return actual !== null && expected !== null && actual === expected;
}

function canonical(ts: Compiler, file: string, source: string): string | null {
  const tree = parsedSource(ts, file, source);
  if (!tree) return null;
  const normalized = ts.transform(tree, [context => root => {
    const visit: import('typescript').Visitor = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'PS_SITE_UUID'
        && node.initializer && ts.isStringLiteral(node.initializer)) {
        return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type,
          ts.factory.createStringLiteral('__PATCHSTACK_SITE_UUID__'));
      }
      if (ts.isStringLiteral(node)) return ts.factory.createStringLiteral(node.text);
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitEachChild(root, visit, context);
  }]);
  try { return ts.createPrinter({ removeComments: true }).printFile(normalized.transformed[0]!); }
  finally { normalized.dispose(); }
}
