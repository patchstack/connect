import { createRequire } from 'node:module';
import { join } from 'node:path';
import type tsType from 'typescript';

type Compiler = typeof tsType;
type Edit = { start: number; end: number; text: string };
export const NEXT_MARKER = '// #region patchstack-next-composed';
export const ROUTE_MARKER = '// #region patchstack-next-route';
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Use the application's parser without executing its source or configuration. */
export function nextCompiler(cwd: string): Compiler | null {
  for (const base of [join(cwd, 'package.json'), import.meta.url]) {
    try { return createRequire(base)('typescript') as Compiler; } catch { /* optional app dependency */ }
  }
  return null;
}

function parse(ts: Compiler, file: string, source: string) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return (sf as typeof sf & { parseDiagnostics: unknown[] }).parseDiagnostics.length ? null : sf;
}

function exported(ts: Compiler, node: tsType.Node): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}

function apply(source: string, edits: Edit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}

function handlers(ts: Compiler, sf: tsType.SourceFile, names: Set<string>) {
  const out: Array<tsType.FunctionDeclaration | tsType.ArrowFunction | tsType.FunctionExpression> = [];
  for (const s of sf.statements) {
    if (!exported(ts, s)) continue;
    if (ts.isFunctionDeclaration(s) && s.name && names.has(s.name.text)) out.push(s);
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && names.has(d.name.text) && d.initializer
            && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) out.push(d.initializer);
      }
    }
  }
  return out;
}

function methodExportCount(ts: Compiler, sf: tsType.SourceFile): number {
  return sf.statements.filter(s => exported(ts, s)).flatMap(s => {
    if (ts.isFunctionDeclaration(s)) return s.name ? [s.name.text] : [];
    if (ts.isVariableStatement(s)) return s.declarationList.declarations.map(d => d.name.getText(sf));
    return [];
  }).filter(n => METHODS.has(n)).length;
}

/** A config that cannot alter URL normalization, established without running it. */
export function standardNextRouting(ts: Compiler, file: string, source: string): boolean {
  const sf = parse(ts, file, source);
  if (!sf) return false;
  const objects = new Map<string, tsType.Expression>();
  let target: tsType.Expression | undefined;
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && s.importClause?.isTypeOnly) continue;
    if (ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Const)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) return false;
        objects.set(d.name.text, d.initializer);
      }
    } else if (ts.isExportAssignment(s) && !s.isExportEquals && !target) target = s.expression;
    else return false;
  }
  const unwrap = (expr: tsType.Expression): tsType.Expression => {
    while (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isParenthesizedExpression(expr)) expr = expr.expression;
    return expr;
  };
  if (!target) return false;
  target = unwrap(target);
  if (ts.isIdentifier(target)) target = objects.get(target.text);
  if (!target) return false;
  target = unwrap(target);
  if (!ts.isObjectLiteralExpression(target)) return false;
  const literal = (node: tsType.Expression): boolean => {
    const expr = unwrap(node);
    if (ts.isStringLiteral(expr) || ts.isNumericLiteral(expr)
        || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(expr.kind)) return true;
    if (ts.isArrayLiteralExpression(expr)) return expr.elements.every(literal);
    if (ts.isObjectLiteralExpression(expr)) return expr.properties.every(p => ts.isPropertyAssignment(p)
      && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && literal(p.initializer));
    return false;
  };
  if (!literal(target) || ![...objects.values()].every(literal)) return false;
  return target.properties.every(p => p.name && !['basePath', 'i18n', 'skipMiddlewareUrlNormalize', 'pageExtensions', '__proto__'].includes(
    ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : '',
  ));
}

/** Only literal paths and a terminal catch-all are widened automatically. */
function matcherRegex(value: string): string | null {
  if (value === '/:path*') return '^/';
  if (!/^\/[\w-]+(?:\/[\w-]+)*(?:\/:\w+\*)?$/.test(value)) return null;
  const catchAll = /\/:\w+\*$/.test(value);
  const prefix = value.replace(/\/:\w+\*$/, '');
  // Next also routes normalized data requests and the optional .json variant through middleware.
  return `^(?:/_next/data/[^/]+)?${prefix}${catchAll ? '(?:/.*)?' : ''}(?:\\.json)?/?$`;
}

function middlewareScope(ts: Compiler, sf: tsType.SourceFile): { tests: string[]; edits: Edit[] } | null {
  const configs = sf.statements.filter(s => ts.isVariableStatement(s) && exported(ts, s))
    .flatMap(s => [...(s as tsType.VariableStatement).declarationList.declarations])
    .filter(d => ts.isIdentifier(d.name) && d.name.text === 'config');
  if (!configs.length) {
    // A re-exported config cannot be inspected without evaluating another module.
    if (sf.statements.some(s => ts.isExportDeclaration(s))) return null;
    return { tests: [], edits: [] };
  }
  const config = configs[0]?.initializer;
  if (configs.length !== 1 || !config || !ts.isObjectLiteralExpression(config)) return null;
  if (config.properties.some(p => !ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name))) return null;
  const matcher = config.properties.find(p => p.name?.getText(sf) === 'matcher') as tsType.PropertyAssignment | undefined;
  if (!matcher) return { tests: [], edits: [] };
  const values = ts.isArrayLiteralExpression(matcher.initializer) ? [...matcher.initializer.elements] : [matcher.initializer];
  if (!values.length || !values.every(v => ts.isStringLiteral(v))) return null;
  const tests = values.map(v => matcherRegex((v as tsType.StringLiteral).text));
  if (tests.some(v => v === null)) return null;
  return {
    tests: tests as string[],
    edits: [{ start: matcher.initializer.getStart(sf), end: matcher.initializer.end, text: '"/:path*"' }],
  };
}

function requestName(ts: Compiler, fn: tsType.FunctionLikeDeclaration): string | null {
  const param = fn.parameters[0];
  if (!param) return 'psRequest';
  if (!ts.isIdentifier(param.name) || param.dotDotDotToken || param.initializer || param.questionToken) return null;
  return param.name.text;
}

function requestParameter(fn: tsType.FunctionLikeDeclaration, file: string): Edit[] {
  return fn.parameters.length ? [] : [{ start: fn.parameters.pos, end: fn.parameters.pos,
    text: file.endsWith('.ts') ? 'psRequest: Request' : 'psRequest' }];
}

function importPosition(ts: Compiler, sf: tsType.SourceFile): number {
  let position = 0;
  for (const statement of sf.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    position = statement.end;
  }
  return position;
}

function prelude(request: string, marker: string): string {
  return `\n  ${marker}\n  const psProtection = await getPatchstackProtection();\n  const psBlocked = psProtection && await psProtection.fetchGuard()(${request});\n  if (psBlocked) return psBlocked;\n  // #endregion\n`;
}

export function composeNextMiddleware(ts: Compiler, file: string, source: string, guardImport: string): string | null {
  const sf = parse(ts, file, source);
  if (!sf || /\b(?:psProtection|psBlocked|psRequest|getPatchstackProtection)\b/.test(source)) return null;
  const found = handlers(ts, sf, new Set(['middleware']));
  if (found.length !== 1 || sf.statements.some(s => ts.isExportAssignment(s) || ts.isExportDeclaration(s))) return null;
  const fn = found[0]!;
  const request = requestName(ts, fn);
  const scope = middlewareScope(ts, sf);
  if (!request || !scope || !fn.body || !ts.isBlock(fn.body) || fn.asteriskToken || fn.type) return null;
  const edits = [...scope.edits, ...requestParameter(fn, file)];
  const isAsync = fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
  if (!isAsync) {
    const start = ts.isFunctionDeclaration(fn)
      ? fn.getChildren(sf).find(n => n.kind === ts.SyntaxKind.FunctionKeyword)!.getStart(sf)
      : fn.getStart(sf);
    edits.push({ start, end: start, text: 'async ' });
  }
  const scopeCheck = scope.tests.length
    ? `  if (!${JSON.stringify(scope.tests)}.some(pattern => new RegExp(pattern).test(new URL(${request}.url).pathname))) return;\n`
    : '';
  edits.push({ start: fn.body.getStart(sf) + 1, end: fn.body.getStart(sf) + 1, text: prelude(request, NEXT_MARKER) + scopeCheck });
  const position = importPosition(ts, sf);
  edits.push({ start: position, end: position, text: `\nimport { getPatchstackProtection } from ${JSON.stringify(guardImport)};\n` });
  return apply(source, edits);
}

/** Keep exported handlers and their input/sink expressions in place for source mapping. */
export function composeNextRoute(ts: Compiler, file: string, source: string, guardImport: string): string | null {
  const sf = parse(ts, file, source);
  if (!sf || /\b(?:psProtection|psBlocked|psRequest|getPatchstackProtection|screenPatchstackResponse)\b/.test(source)) return null;
  const found = handlers(ts, sf, METHODS);
  if (!found.length || sf.statements.some(s => ts.isExportDeclaration(s) || ts.isExportAssignment(s))) return null;
  // Unrecognized method exports must remain visible as a coverage gap, not a partial success.
  if (methodExportCount(ts, sf) !== found.length) return null;
  const edits: Edit[] = [];
  for (const fn of found) {
    const request = requestName(ts, fn);
    if (!request || !fn.body || !ts.isBlock(fn.body) || fn.asteriskToken || fn.type
        || !fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
    const returns: tsType.ReturnStatement[] = [];
    const visit = (node: tsType.Node) => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) returns.push(node);
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    if (!returns.length || returns.some(r => !r.expression)) return null;
    for (const r of returns) {
      const expr = r.expression!;
      edits.push({ start: expr.getStart(sf), end: expr.end,
        text: `screenPatchstackResponse((${expr.getText(sf)}), ${request}, psProtection)` });
    }
    edits.push(...requestParameter(fn, file));
    edits.push({ start: fn.body.getStart(sf) + 1, end: fn.body.getStart(sf) + 1, text: prelude(request, ROUTE_MARKER) });
  }
  const position = importPosition(ts, sf);
  edits.push({ start: position, end: position, text: `\nimport { getPatchstackProtection, screenPatchstackResponse } from ${JSON.stringify(guardImport)};\n` });
  return apply(source, edits);
}

export function nextSourceWired(ts: Compiler, file: string, source: string, guardImport: string, route = false): boolean {
  const sf = parse(ts, file, source);
  if (!sf) return false;
  const imported = sf.statements.some(s => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)
    && s.moduleSpecifier.text === guardImport && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
    && s.importClause.namedBindings.elements.some(e => !e.propertyName && e.name.text === 'getPatchstackProtection'));
  if (!imported) return false;
  if (route && !sf.statements.some(s => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)
    && s.moduleSpecifier.text === guardImport && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
    && s.importClause.namedBindings.elements.some(e => !e.propertyName && e.name.text === 'screenPatchstackResponse'))) return false;
  const found = handlers(ts, sf, route ? METHODS : new Set(['middleware']));
  if (!found.length || sf.statements.some(s => ts.isExportDeclaration(s) || ts.isExportAssignment(s))) return false;
  if (route && methodExportCount(ts, sf) !== found.length) return false;
  const compact = (text: string) => text.replace(/\s+/g, '');
  for (const fn of found) {
    const request = requestName(ts, fn);
    if (!request || !fn.body || !ts.isBlock(fn.body)) return false;
    const head = fn.body.statements.slice(0, 3).map(s => s.getText(sf)).join('');
    const expected = `const psProtection = await getPatchstackProtection();
      const psBlocked = psProtection && await psProtection.fetchGuard()(${request});
      if (psBlocked) return psBlocked;`;
    if (compact(head) !== compact(expected)) return false;
    if (route) {
      let covered = true;
      const visit = (node: tsType.Node) => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node) && node.expression?.getText(sf) !== 'psBlocked') {
          const expr = node.expression;
          if (!expr || !ts.isCallExpression(expr) || expr.expression.getText(sf) !== 'screenPatchstackResponse'
              || expr.arguments[1]?.getText(sf) !== request || expr.arguments[2]?.getText(sf) !== 'psProtection') covered = false;
        }
        ts.forEachChild(node, visit);
      };
      visit(fn.body);
      if (!covered) return false;
    }
  }
  if (!route) {
    const scope = middlewareScope(ts, sf);
    if (!scope || scope.tests.some(test => test !== '^/')) return false;
  }
  return true;
}
