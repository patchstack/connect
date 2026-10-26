import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { bakeSiteUuid, hasDependency, log, read, templatesDir } from '../util.js';
import { sourceCompiler, parsedSource, type Compiler } from '../syntax.js';
import { installTemplate } from '../template-upgrade.js';
import { copyProjectFileSync, ensureProjectDirectorySync, writeProjectFileSync } from '../../../safe-file.js';
import type { Adapter } from '../types.js';
import { matchesGuardTemplate } from '../template-match.js';

const ENTRY = 'src/server.ts';
const GUARD = 'src/patchstack/guard.ts';
const IMPORT = 'import { protectFetch } from "./patchstack/guard";';
const DEFAULT = `import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
export default createServerEntry({ fetch: handler.fetch.bind(handler) });
`;
const EXTENSIONS = ['ts', 'js', 'mts', 'mjs', 'tsx', 'jsx', 'cts', 'cjs'];
/** TanStack Start's own server entry, which a Cloudflare Worker runs when wrangler's `main` names it. */
const PACKAGE_ENTRY = '@tanstack/react-start/server-entry';
const WRANGLER_CONFIGS = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];
const MAIN = /^(\s*"main"\s*:\s*|main\s*=\s*)"([^"]*)"/m;

/**
 * The Cloudflare Worker this app deploys as, when it builds with `@cloudflare/vite-plugin`: its wrangler
 * config and the module that config names as `main`. That module is what the Worker runs, so the vite
 * config's own entry setting does not decide it. Null when the app is not a Cloudflare Worker build, or
 * its Worker entry cannot be read.
 */
function workerEntry(cwd: string, configs: string[]): { file: string; main: string } | null {
  if (!configs.some(file => read(join(cwd, file)).includes('@cloudflare/vite-plugin'))) return null;
  const file = WRANGLER_CONFIGS.find(name => existsSync(join(cwd, name)));
  const main = file ? MAIN.exec(read(join(cwd, file)))?.[2] : undefined;

  return file && main !== undefined ? { file, main } : null;
}

/** Whether a wrangler `main` names the managed server entry. */
function runsManagedEntry(main: string): boolean {
  return main.replace(/^\.\//, '') === ENTRY;
}

/** A Vite config wrapper that adds tanstackStart() itself, passing its `tanstackStart` option through. */
const START_CONFIG_WRAPPER = '@lovable.dev/vite-tanstack-config';

/** Prove the default entry from literal configuration without executing application code. */
function defaultEntryConfig(ts: Compiler, file: string, source: string): boolean {
  const tree = parsedSource(ts, file, source);
  if (!tree) return false;
  const binding = (module: string, name: string) => tree.statements.filter(ts.isImportDeclaration)
    .filter(n => ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === module && !n.importClause?.isTypeOnly)
    .flatMap(n => n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)
      ? n.importClause.namedBindings.elements.filter(e => !e.isTypeOnly && (e.propertyName ?? e.name).text === name).map(e => e.name.text) : []);
  const defineConfig = binding('vite', 'defineConfig');
  const wrapper = binding(START_CONFIG_WRAPPER, 'defineConfig');
  const start = binding('@tanstack/react-start/plugin/vite', 'tanstackStart');
  const unwrap = (expression: import('typescript').Expression): import('typescript').Expression => {
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
    return expression;
  };
  const exports = tree.statements.filter(ts.isExportAssignment);
  if (exports.length !== 1 || exports[0]!.isExportEquals) return false;
  let config = unwrap(exports[0]!.expression);
  let wrapped = false;
  if (ts.isCallExpression(config)) {
    if (!ts.isIdentifier(config.expression)) return false;
    wrapped = wrapper.includes(config.expression.text);
    // The wrapper's own tanstackStart() keeps the default entry; importing another one would compete with it.
    if (wrapped && start.length > 0) return false;
    if (wrapped && config.arguments.length === 0) return true;
    if (!(wrapped || defineConfig.includes(config.expression.text)) || config.arguments.length !== 1) return false;
    config = unwrap(config.arguments[0]!);
  }
  if (!ts.isObjectLiteralExpression(config)) return false;
  let unsafe = false;
  // `server: { entry: "server" }` names src/server.ts, which is the default entry anyway (Lovable's template
  // sets it to point TanStack at its own wrapper there). Any other value moves the entry.
  const namesDefaultEntry = (value: import('typescript').Expression): boolean => {
    const server = unwrap(value);
    if (!ts.isObjectLiteralExpression(server) || server.properties.length !== 1) return false;
    const entry = server.properties[0]!;
    return ts.isPropertyAssignment(entry) && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name))
      && entry.name.text === 'entry' && ts.isStringLiteral(unwrap(entry.initializer))
      && ['server', './server'].includes((unwrap(entry.initializer) as import('typescript').StringLiteral).text);
  };
  const visit = (node: import('typescript').Node) => {
    if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node) || ts.isComputedPropertyName(node)) unsafe = true;
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set<string>();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) { unsafe = true; continue; }
        const name = property.name.text;
        if (names.has(name)) unsafe = true;
        names.add(name);
        if (name === 'server' && namesDefaultEntry(property.initializer)) continue;
        if (['srcDirectory', 'serverEntry', 'entry', 'server', 'root'].includes(name)) unsafe = true;
        visit(property.initializer);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(config);
  if (unsafe) return false;
  if (wrapped) {
    const options = config.properties.find(p => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'tanstackStart');
    return !options || (ts.isPropertyAssignment(options) && ts.isObjectLiteralExpression(unwrap(options.initializer)));
  }
  const plugins = config.properties.find(p => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'plugins');
  if (!plugins || !ts.isPropertyAssignment(plugins) || !ts.isArrayLiteralExpression(plugins.initializer)) return false;
  const calls = plugins.initializer.elements.map(unwrap).filter(n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && start.includes(n.expression.text));
  if (calls.length !== 1) return false;
  const call = calls[0]!;
  return ts.isCallExpression(call) && (call.arguments.length === 0
    || (call.arguments.length === 1 && ts.isObjectLiteralExpression(unwrap(call.arguments[0]!))));
}

function viteConfigs(cwd: string): string[] {
  return ['vite', 'app', 'rsbuild'].flatMap(name => EXTENSIONS.map(ext => `${name}.config.${ext}`))
    .filter(file => existsSync(join(cwd, file)));
}

function entryProblem(cwd: string): string | null {
  try {
    const file = createRequire(join(cwd, 'package.json')).resolve('@tanstack/react-start/package.json');
    if (!JSON.parse(read(file)).exports?.['./server-entry']) return 'the installed TanStack Start version does not expose server-entry';
  }
  catch { return 'the installed TanStack Start version must expose its server-entry contract'; }
  const entries = ['src/server', 'server', ...EXTENSIONS.flatMap(ext => [`src/server.${ext}`, `server.${ext}`])];
  if (entries.some(file => file !== ENTRY && existsSync(join(cwd, file)))) {
    return 'non-default or competing server entries require manual integration';
  }
  const configs = viteConfigs(cwd);
  // A Cloudflare Worker runs the module its wrangler config names. TanStack's own entry can be pointed at
  // the managed one (`protect` does that); anything else is the app's own and is left to it.
  const worker = workerEntry(cwd, configs);
  if (worker) {
    return runsManagedEntry(worker.main) || worker.main === PACKAGE_ENTRY
      ? null
      : `the Cloudflare Worker entry (\`main\` in ${worker.file}) is a custom module; wrap its Fetch handler manually`;
  }
  if (configs.length) {
    const ts = sourceCompiler(cwd);
    if (configs.length !== 1 || !configs[0]!.startsWith('vite.') || !ts
      || !defaultEntryConfig(ts, configs[0]!, read(join(cwd, configs[0]!)))) {
      return 'the default server entry cannot be established from this configuration; integrate it manually';
    }
  }
  return null;
}

/**
 * Compose only literal entry shapes; never evaluate app config. The entry is `createServerEntry({ fetch })`
 * or a plain `export default { fetch }` object, the shape of a server wrapper the app keeps at src/server.ts
 * (Lovable's template wraps TanStack's handler there for error pages).
 */
export function composeTanstackEntry(ts: Compiler, source: string): string | null {
  const tree = parsedSource(ts, ENTRY, source);
  if (!tree || /\bprotectFetch\b/.test(source) || ownProtection(source)) return null;
  const imported = tree.statements.some(node => ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@tanstack/react-start/server-entry'
    && !node.importClause?.isTypeOnly && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(e => !e.propertyName && !e.isTypeOnly && e.name.text === 'createServerEntry'));
  const exports = tree.statements.filter(ts.isExportAssignment);
  if (exports.length !== 1 || exports[0]!.isExportEquals) return null;
  const exported = exports[0]!.expression;
  let object: import('typescript').Expression;
  if (ts.isObjectLiteralExpression(exported)) object = exported;
  else {
    if (!imported) return null;
    if (!ts.isCallExpression(exported) || exported.expression.getText(tree) !== 'createServerEntry' || exported.arguments.length !== 1) return null;
    object = exported.arguments[0]!;
  }
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

/** Whether the entry builds its own Patchstack protection rather than importing the managed guard. */
function ownProtection(source: string): boolean {
  return /['"]@patchstack\/connect(?:\/protect)?['"]/.test(source);
}

function wiredEntry(ts: Compiler, source: string): boolean {
  const tree = parsedSource(ts, ENTRY, source);
  if (!tree) return false;
  // The managed import by meaning, not spelling: quotes and spacing are the formatter's.
  const imported = tree.statements.filter(ts.isImportDeclaration).filter(n => ts.isStringLiteral(n.moduleSpecifier)
    && n.moduleSpecifier.text === './patchstack/guard' && !n.importClause?.isTypeOnly && !n.importClause?.name
    && !!n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)
    && n.importClause.namedBindings.elements.length === 1
    && !n.importClause.namedBindings.elements[0]!.propertyName && n.importClause.namedBindings.elements[0]!.name.text === 'protectFetch');
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
  const importText = imported[0]!.getText(tree);
  const composed = composeTanstackEntry(ts, plain.replace(importText, ''))?.replace(IMPORT, importText);
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
    if (ownProtection(previous) && !wiredEntry(ts, previous)) {
      log(`${ENTRY} creates its own Patchstack protection, so it was left untouched. Setup keeps the rules file it passes current, read-only rules credential included, so it fetches rule updates without a key. To use the managed guard instead, remove that code (the createProtection call and that rules file) and run protect again.`);
      return {ok:false,changed:[]};
    }
    const next = wiredEntry(ts, previous) ? previous : composeTanstackEntry(ts, previous);
    if (!next) { log('Custom TanStack server entry left untouched; wrap its final Fetch boundary manually.'); return {ok:false,changed:[]}; }
    const changed: string[] = [];
    ensureProjectDirectorySync(cwd, join(cwd, 'src/patchstack'));
    if (installTemplate(cwd, GUARD, 'fetch-guard.ts')) changed.push(GUARD);
    if (!matchesGuardTemplate(cwd, GUARD, 'fetch-guard.ts')) {
      log('Custom Fetch helper needs manual review; the server entry was left untouched.');
      return {ok:false,changed};
    }
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
    const worker = workerEntry(cwd, viteConfigs(cwd));
    if (worker && worker.main === PACKAGE_ENTRY) {
      const config = read(join(cwd, worker.file));
      writeProjectFileSync(cwd, join(cwd, worker.file), config.replace(MAIN, (_, key: string) => `${key}"./${ENTRY}"`));
      changed.push(worker.file);
      log(`Cloudflare Worker entry (\`main\` in ${worker.file}) now runs ${ENTRY}.`);
    }
    log('TanStack server entry screens requests and final Responses; browser-direct backend traffic and separately deployed functions need their own protection.');
    return {ok:true,changed};
  },
  verify(cwd) {
    const ts = sourceCompiler(cwd);
    const problem = entryProblem(cwd);
    const worker = workerEntry(cwd, viteConfigs(cwd));
    const workerProblem = worker && !runsManagedEntry(worker.main)
      ? `the Cloudflare Worker runs \`${worker.main}\` (\`main\` in ${worker.file}), not ${ENTRY}; run protect`
      : null;
    const wired = !problem && !workerProblem && !!ts && existsSync(join(cwd,ENTRY)) && wiredEntry(ts,read(join(cwd,ENTRY)))
      && matchesGuardTemplate(cwd,GUARD,'fetch-guard.ts') && existsSync(join(cwd,'src/patchstack/rules.json'));
    return {wired,checks:[{label:'TanStack server Fetch boundary wired',ok:wired,hint:problem ?? workerProblem ?? 'run protect; manually review unsupported custom server entries'},
      {label:'browser-direct services and separately deployed functions are not covered by this entry',ok:true,unverifiable:true,hint:'install protection at each independently exposed backend; retain backend authorization and RLS'}]};
  },
};
