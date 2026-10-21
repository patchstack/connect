// Adapter: React Router v7 (framework mode) — the shape Hostinger Horizons and other builders generate.
// There is no auto-discovered middleware file: a root route owns request handling, so the guard is a
// `.server` module wired from the root route's `middleware` export. The root file (and often the server
// entry and start script) is the only safe seam — builders mark the rest read-only.
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { bakeSiteUuid, hasDependency, log, read, templatesDir } from '../util.js';
import { sourceCompiler, parsedSource, type Compiler } from '../syntax.js';
import { matchesGuardTemplate } from '../template-match.js';
import { copyProjectFileSync, ensureProjectDirectorySync, writeProjectFileSync } from '../../../safe-file.js';
import type { Adapter, WireOptions, WireResult, VerifyResult } from '../types.js';

const TEMPLATE = 'react-router-guard.server.ts';
const ROOTS = ['app/root.tsx', 'src/root.tsx', 'app/root.jsx', 'src/root.jsx'];
const IMPORT_NAME = 'patchstackRootMiddleware';

/** The project's root route module, where React Router reads a `middleware` export that runs for every route. */
function rootFile(cwd: string): string | null {
  return ROOTS.find(rel => existsSync(join(cwd, rel))) ?? null;
}

function guardRel(rootRel: string): string {
  const dir = dirname(rootRel);
  return join(dir, 'patchstack', 'guard.server.ts').replace(/\\/g, '/');
}

function rulesRel(rootRel: string): string {
  return join(dirname(rootRel), 'patchstack', 'patchstack.rules.json').replace(/\\/g, '/');
}

/** The specifier a root route uses to import the guard beside it, e.g. `./patchstack/guard.server`. */
function guardSpecifier(rootRel: string): string {
  let spec = relative(dirname(rootRel), guardRel(rootRel)).replace(/\\/g, '/').replace(/\.tsx?$/, '');
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return spec;
}

/** Whether a module already exports a `middleware` binding (ours or the app's own). */
function exportsMiddleware(ts: Compiler, tree: import('typescript').SourceFile): boolean {
  return tree.statements.some(node =>
    ts.isVariableStatement(node)
    && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'middleware'));
}

/** Whether the root route wires OUR middleware — the import and a `middleware` export that names it. */
function wiredRoot(ts: Compiler, source: string, rootRel: string): boolean {
  const tree = parsedSource(ts, rootRel, source);
  if (!tree) return false;
  const imported = tree.statements.some(node => ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === guardSpecifier(rootRel)
    && !node.importClause?.isTypeOnly && !!node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(e => !e.isTypeOnly && (e.propertyName ?? e.name).text === IMPORT_NAME));
  if (!imported) return false;
  return tree.statements.some(node => ts.isVariableStatement(node)
    && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'middleware'
      && d.initializer !== undefined && new RegExp(`\\b${IMPORT_NAME}\\b`).test(d.initializer.getText(tree))));
}

/** Add the import and a `middleware` export to a root route that has neither. Null if it cannot be done safely. */
function composeRoot(ts: Compiler, source: string, rootRel: string): string | null {
  const tree = parsedSource(ts, rootRel, source);
  if (!tree) return null;
  // A root that already owns a `middleware` export is left to its author — composing into an array we did
  // not write risks changing order or duplicating a guard. The plan line tells them the one edit to make.
  if (exportsMiddleware(ts, tree)) return null;
  const importLine = `import { ${IMPORT_NAME} } from "${guardSpecifier(rootRel)}";`;
  const exportLine = `export const middleware = [${IMPORT_NAME}];`;
  const lastImport = tree.statements.filter(ts.isImportDeclaration).at(-1);
  const at = lastImport?.end ?? 0;
  const next = `${source.slice(0, at)}\n${importLine}${source.slice(at)}\n\n${exportLine}\n`;
  return parsedSource(ts, rootRel, next) ? next : null;
}

function detect(cwd: string): boolean {
  // Framework mode specifically (not react-router as a plain SPA library): the dev/build package is what
  // creates the root route and server entry this wires into.
  const framework = ['@react-router/dev', '@react-router/node', '@react-router/serve']
    .some(dep => hasDependency(cwd, dep));
  return framework && rootFile(cwd) !== null;
}

function wire(cwd: string, opts: WireOptions): WireResult {
  const ts = sourceCompiler(cwd);
  const rootRel = rootFile(cwd);
  if (!ts || rootRel === null) {
    log('React Router root route not found (app/root.tsx or src/root.tsx); guard left uninstalled.');
    return { ok: false, changed: [] };
  }

  const changed: string[] = [];
  ensureProjectDirectorySync(cwd, dirname(join(cwd, guardRel(rootRel))));
  const guardAbs = join(cwd, guardRel(rootRel));
  if (!existsSync(guardAbs)) {
    copyProjectFileSync(cwd, join(templatesDir(), TEMPLATE), guardAbs);
    if (!opts.demo) bakeSiteUuid(cwd, guardRel(rootRel));
    changed.push(guardRel(rootRel));
  } else if (!matchesGuardTemplate(cwd, guardRel(rootRel), TEMPLATE)) {
    log('Custom guard.server.ts left untouched; review its request/response wiring manually.');
  }

  const rulesAbs = join(cwd, rulesRel(rootRel));
  if (opts.demo || !existsSync(rulesAbs)) {
    copyProjectFileSync(cwd, join(templatesDir(), opts.demo ? 'demo-rules.json' : 'rules.json'), rulesAbs);
    changed.push(rulesRel(rootRel));
  }

  const source = read(join(cwd, rootRel));
  if (wiredRoot(ts, source, rootRel)) {
    return { ok: true, changed: [...new Set(changed)] };
  }
  const composed = composeRoot(ts, source, rootRel);
  if (composed === null) {
    log(`existing ${rootRel} already defines middleware — add \`${IMPORT_NAME}\` to its \`middleware\` array by hand: `
      + `import { ${IMPORT_NAME} } from "${guardSpecifier(rootRel)}"; then: npx @patchstack/connect protect --check`);
    return { ok: false, changed: [...new Set(changed)] };
  }
  writeProjectFileSync(cwd, join(cwd, rootRel), composed);
  changed.push(rootRel);
  log(`wired the guard into ${rootRel} (root middleware); screens requests and responses for every route.`);
  return { ok: true, changed: [...new Set(changed)] };
}

function verify(cwd: string): VerifyResult {
  const ts = sourceCompiler(cwd);
  const rootRel = rootFile(cwd);
  const wired = !!ts && rootRel !== null && wiredRoot(ts, read(join(cwd, rootRel)), rootRel)
    && existsSync(join(cwd, guardRel(rootRel)))
    && matchesGuardTemplate(cwd, guardRel(rootRel), TEMPLATE)
    && existsSync(join(cwd, rulesRel(rootRel)));
  return {
    wired,
    checks: [{
      label: 'React Router root middleware wired',
      ok: wired,
      hint: rootRel === null
        ? 'React Router root route not found (app/root.tsx or src/root.tsx)'
        : `run \`patchstack-connect protect\`; a hand-defined middleware export needs ${IMPORT_NAME} added manually`,
    }],
  };
}

export const reactRouterAdapter: Adapter = {
  name: 'react-router',
  label: 'React Router',
  detect,
  wire,
  verify,
};
