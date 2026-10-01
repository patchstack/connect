import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { bakeSiteUuid, hasDependency, log, read, templatesDir } from '../util.js';
import { sourceCompiler, parsedSource, type Compiler } from '../syntax.js';
import { installTemplate } from '../template-upgrade.js';
import { copyProjectFileSync, ensureProjectDirectorySync, writeProjectFileSync } from '../../../safe-file.js';
import type { Adapter } from '../types.js';
import { templateWiringPresent } from '../seam.js';

const ENTRY = 'src/server.ts';
const GUARD = 'src/patchstack/guard.ts';
const IMPORT = 'import { protectFetch } from "./patchstack/guard";';
const DEFAULT = `import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
export default createServerEntry({ fetch: handler.fetch.bind(handler) });
`;

function entryProblem(cwd: string): string | null {
  try {
    const file = createRequire(join(cwd, 'package.json')).resolve('@tanstack/react-start/package.json');
    if (!JSON.parse(read(file)).exports?.['./server-entry']) return 'the installed TanStack Start version does not expose server-entry';
  }
  catch { return 'the installed TanStack Start version must expose its server-entry contract'; }
  if (['src/server.js', 'src/server.tsx', 'src/server.jsx', 'server.ts', 'server.js'].some(file => existsSync(join(cwd, file)))) {
    return 'non-default or competing server entries require manual integration';
  }
  // A custom source directory or server entry can make src/server.ts an unused file.
  for (const file of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'app.config.ts']) {
    if (!existsSync(join(cwd, file))) continue;
    const source = read(join(cwd, file));
    if (/\b(?:srcDirectory|serverEntry|entry|server|root)\s*:|\.\.\./.test(source)) return 'custom Vite/Start entry configuration requires manual integration';
  }
  return null;
}

/** Compose only the documented literal createServerEntry shape; never evaluate app config. */
export function composeTanstackEntry(ts: Compiler, source: string): string | null {
  const tree = parsedSource(ts, ENTRY, source);
  if (!tree || /\bprotectFetch\b/.test(source)) return null;
  const imported = tree.statements.some(node => ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@tanstack/react-start/server-entry'
    && !node.importClause?.isTypeOnly && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(e => !e.propertyName && !e.isTypeOnly && e.name.text === 'createServerEntry'));
  if (!imported) return null;
  const exports = tree.statements.filter(ts.isExportAssignment);
  if (exports.length !== 1 || exports[0]!.isExportEquals) return null;
  const call = exports[0]!.expression;
  if (!ts.isCallExpression(call) || call.expression.getText(tree) !== 'createServerEntry' || call.arguments.length !== 1) return null;
  const object = call.arguments[0]!;
  if (!ts.isObjectLiteralExpression(object) || object.properties.some(p => ts.isSpreadAssignment(p) || !p.name || ts.isComputedPropertyName(p.name))) return null;
  const properties = object.properties.filter(p => p.name?.getText(tree) === 'fetch');
  if (properties.length !== 1) return null;
  const fetch = properties[0]!;
  let replacement: string;
  if (ts.isPropertyAssignment(fetch)) replacement = `fetch: protectFetch(${fetch.initializer.getText(tree)})`;
  else if (ts.isMethodDeclaration(fetch) && fetch.body && !fetch.asteriskToken) {
    const text = fetch.getText(tree);
    replacement = `fetch: protectFetch(${text.replace(/^(async\s+)?fetch\s*\(/, '$1function (')})`;
  } else if (ts.isShorthandPropertyAssignment(fetch)) replacement = 'fetch: protectFetch(fetch)';
  else return null;
  const patched = source.slice(0, fetch.getStart(tree)) + replacement + source.slice(fetch.end);
  const insertion = tree.statements.filter(ts.isImportDeclaration).at(-1)?.end ?? 0;
  const result = patched.slice(0, insertion) + '\n' + IMPORT + '\n' + patched.slice(insertion);
  return parsedSource(ts, ENTRY, result) ? result : null;
}

function wiredEntry(ts: Compiler, source: string): boolean {
  const tree = parsedSource(ts, ENTRY, source);
  if (!tree) return false;
  const imported = tree.statements.filter(ts.isImportDeclaration).filter(n => n.getText(tree) === IMPORT);
  if (imported.length !== 1) return false;
  // Removing just the managed wrapper must recover a supported entry that composes identically.
  const wrappers: import('typescript').CallExpression[] = [];
  const visit = (node: import('typescript').Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'protectFetch') wrappers.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (wrappers.length !== 1 || wrappers[0]!.arguments.length !== 1) return false;
  const wrapper = wrappers[0]!;
  const plain = source.slice(0, wrapper.getStart(tree)) + wrapper.arguments[0]!.getText(tree) + source.slice(wrapper.end);
  const composed = composeTanstackEntry(ts, plain.replace(IMPORT, ''));
  const reparsed = composed && parsedSource(ts, ENTRY, composed);
  const printer = ts.createPrinter({removeComments:true});
  return !!reparsed && printer.printFile(reparsed) === printer.printFile(tree);
}

export const tanstackAdapter: Adapter = {
  name: 'tanstack-start', label: 'TanStack Start', detect: cwd => hasDependency(cwd, '@tanstack/react-start'),
  wire(cwd, opts) {
    const problem = entryProblem(cwd);
    const ts = sourceCompiler(cwd);
    if (problem || !ts) { log(`TanStack server entry left untouched: ${problem ?? 'parser unavailable'}.`); return {ok:false,changed:[]}; }
    const previous = existsSync(join(cwd, ENTRY)) ? read(join(cwd, ENTRY)) : DEFAULT;
    const next = wiredEntry(ts, previous) ? previous : composeTanstackEntry(ts, previous);
    if (!next) { log('Custom TanStack server entry left untouched; wrap its final Fetch boundary manually.'); return {ok:false,changed:[]}; }
    const changed: string[] = [];
    ensureProjectDirectorySync(cwd, join(cwd, 'src/patchstack'));
    if (installTemplate(cwd, GUARD, 'fetch-guard.ts')) changed.push(GUARD);
    const rules = 'src/patchstack/rules.json';
    if (opts.demo || !existsSync(join(cwd,rules))) {
      copyProjectFileSync(cwd, join(templatesDir(),opts.demo ? 'demo-rules.json' : 'rules.json'),join(cwd,rules));
      changed.push(rules);
    }
    if (!opts.demo && bakeSiteUuid(cwd, GUARD)) changed.push(GUARD);
    if (next !== previous || !existsSync(join(cwd,ENTRY))) {
      writeProjectFileSync(cwd,join(cwd,ENTRY),next);
      changed.push(ENTRY);
    }
    log('TanStack server entry screens requests and final Responses; browser-direct backend traffic and separately deployed functions need their own protection.');
    return {ok:true,changed};
  },
  verify(cwd) {
    const ts = sourceCompiler(cwd);
    const problem = entryProblem(cwd);
    const wired = !problem && !!ts && existsSync(join(cwd,ENTRY)) && wiredEntry(ts,read(join(cwd,ENTRY)))
      && existsSync(join(cwd,GUARD)) && templateWiringPresent(cwd,GUARD,'fetch-guard.ts') && existsSync(join(cwd,'src/patchstack/rules.json'));
    return {wired,checks:[{label:'TanStack server Fetch boundary wired',ok:wired,hint:problem ?? 'run protect; manually review unsupported custom server entries'},
      {label:'browser-direct services and separately deployed functions are not covered by this entry',ok:true,unverifiable:true,hint:'install protection at each independently exposed backend; retain backend authorization and RLS'}]};
  },
};
