import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parsedSource, sourceCompiler, type Compiler } from './syntax.js';
import { read, templatesDir } from './util.js';

/**
 * Unknown executable helper code requires manual integration, not an automatic import.
 *
 * The documented reporting opt-outs are the one edit that still matches: they switch reporting off and
 * change nothing about what the guard screens, and AGENT-INSTALL.md names them as the way to do it.
 */
export function matchesGuardTemplate(cwd: string, file: string, template: string): boolean {
  if (!existsSync(join(cwd, file))) return false;
  const ts = sourceCompiler(cwd);
  if (!ts) return false;
  const actual = canonical(ts, file, read(join(cwd, file)));
  const expected = canonical(ts, template, read(join(templatesDir(), template)));
  return actual !== null && expected !== null && actual === expected;
}

/** `createProtection` options whose `false` only switches a report off. */
const REPORTING_OPT_OUTS = new Set(['reportDetections', 'reportFirewallLog']);

function isReportingOptOut(ts: Compiler, property: import('typescript').ObjectLiteralElementLike): boolean {
  return ts.isPropertyAssignment(property)
    && ts.isIdentifier(property.name)
    && REPORTING_OPT_OUTS.has(property.name.text)
    && property.initializer.kind === ts.SyntaxKind.FalseKeyword;
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
      if (ts.isObjectLiteralExpression(node)) {
        const kept = node.properties.filter((property) => !isReportingOptOut(ts, property));
        const next = kept.length === node.properties.length ? node : ts.factory.updateObjectLiteralExpression(node, kept);
        return ts.visitEachChild(next, visit, context);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitEachChild(root, visit, context);
  }]);
  try { return ts.createPrinter({ removeComments: true }).printFile(normalized.transformed[0]!); }
  finally { normalized.dispose(); }
}
