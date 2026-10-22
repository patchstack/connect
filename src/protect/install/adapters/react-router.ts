// Adapter: React Router v7 (framework mode) — the shape Hostinger Horizons and other builders generate.
// There is no auto-discovered middleware file: a root route owns request handling, so the guard is a
// `.server` module wired from the root route's `middleware` export. The root file (and often the server
// entry and start script) is the only safe seam — builders mark the rest read-only.
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { bakeSiteUuid, hasDependency, log, read, templatesDir } from '../util.js';
import { sourceCompiler, parsedSource, type Compiler } from '../syntax.js';
import {
  ensureMiddlewareFlagEnabled,
  hasMiddlewareFlag,
  middlewareFlagFor,
  reactRouterConfigFile,
} from '../react-router-middleware.js';
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
  } else if (!opts.demo && bakeSiteUuid(cwd, guardRel(rootRel))) {
    // A managed guard written before the site existed (or before its config was found) still carries the
    // placeholder; without a site it fetches no rules and reports nothing, so a re-run fills it in.
    changed.push(guardRel(rootRel));
  }

  const rulesAbs = join(cwd, rulesRel(rootRel));
  if (opts.demo || !existsSync(rulesAbs)) {
    copyProjectFileSync(cwd, join(templatesDir(), opts.demo ? 'demo-rules.json' : 'rules.json'), rulesAbs);
    changed.push(rulesRel(rootRel));
  }

  // React Router ignores a route `middleware` export unless the matching future flag is on, so a guard
  // wired as middleware runs on nothing without it. Turn it on in react-router.config for versions that
  // need it (v8 has it on by default); report the one line to add when the config cannot be edited blind.
  const flag = middlewareFlagFor(cwd);
  if (flag !== null) {
    const outcome = ensureMiddlewareFlagEnabled(cwd, flag);
    const configRel = reactRouterConfigFile(cwd);
    if (outcome === 'enabled' && configRel !== null) {
      changed.push(configRel);
      log(`enabled React Router middleware (future.${flag}) in ${configRel}; without it the guard is wired but never runs.`);
    } else if (outcome === 'no-config') {
      log(`React Router middleware is off: add react-router.config.ts with \`future: { ${flag}: true }\`, or the wired guard will not run.`);
    } else if (outcome === 'manual') {
      log(`React Router middleware is off: add \`future: { ${flag}: true }\` to your react-router.config so the wired guard runs.`);
    }
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
  const rootWired = !!ts && rootRel !== null && wiredRoot(ts, read(join(cwd, rootRel)), rootRel)
    && existsSync(join(cwd, guardRel(rootRel)))
    && matchesGuardTemplate(cwd, guardRel(rootRel), TEMPLATE)
    && existsSync(join(cwd, rulesRel(rootRel)));

  // A wired middleware export does nothing until React Router's middleware future flag is on, so the flag
  // is part of being wired — not an optional extra. Versions that need none (v8) pass this trivially.
  const flag = middlewareFlagFor(cwd);
  const flagOn = flag === null || hasMiddlewareFlag(cwd, flag);

  const checks: VerifyResult['checks'] = [{
    label: 'React Router root middleware wired',
    ok: rootWired,
    hint: rootRel === null
      ? 'React Router root route not found (app/root.tsx or src/root.tsx)'
      : `run \`patchstack-connect protect\`; a hand-defined middleware export needs ${IMPORT_NAME} added manually`,
  }];
  if (flag !== null) {
    checks.push({
      label: `React Router middleware enabled (future.${flag})`,
      ok: flagOn,
      hint: reactRouterConfigFile(cwd) === null
        ? `add react-router.config.ts with \`future: { ${flag}: true }\` — without it the guard is wired but never runs`
        : `add \`future: { ${flag}: true }\` to your react-router.config — without it the guard is wired but never runs`,
    });
  }

  return { wired: rootWired && flagOn, checks };
}

export const reactRouterAdapter: Adapter = {
  name: 'react-router',
  label: 'React Router',
  detect,
  wire,
  verify,
};
