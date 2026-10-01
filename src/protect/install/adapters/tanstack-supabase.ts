// Adapter: TanStack Start + Supabase (the shape Lovable emits).
//
// Wires the always-on guard with zero changes to the user's own code — patches the generated
// Supabase client (browser→Supabase tunnel) and src/start.ts (request + function middleware),
// scaffolds src/integrations/patchstack/{guard.ts,rules.json}, and bakes the site UUID.
// Idempotent + upgrades in place via the managed `#region` blocks.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bakeSiteUuid, read, log, templatesDir } from '../util.js';
import type { Adapter, WireOptions, WireResult, VerifyResult } from '../types.js';
import { copyProjectFileSync, ensureProjectDirectorySync, writeProjectFileSync } from '../../../safe-file.js';
import { parsedSource, sourceCompiler, type Compiler } from '../syntax.js';

const CLIENT_TUNNEL = [
  '',
  "    // PATCHSTACK: in the browser, tunnel Supabase traffic through the app's own server guard",
  '    // (same-origin) so payloads are inspected before they reach Supabase.',
  "    if (typeof window !== 'undefined') {",
  '      const original = new Request(input, init);',
  "      const guardUrl = new URL('/_patchstack/guard', window.location.origin).toString();",
  '      const forwarded = new Request(guardUrl, original);',
  '      headers.forEach((value, key) => forwarded.headers.set(key, value));',
  "      forwarded.headers.set('x-ps-target', original.url);",
  '      return fetch(forwarded);',
  '    }',
  '',
].join('\n');

const GUARD_IMPORT =
  'import { GUARD_PATH, handleGuardRequest, inspectServerFn, screenResponse, guardRequest } from "@/integrations/patchstack/guard";';
const GUARD_IMPORT_RE = /import \{[^}]*\} from "@\/integrations\/patchstack\/guard";/;

const START_IMPORTS = ['import { getRequest } from "@tanstack/react-start/server";', GUARD_IMPORT].join('\n');

// Managed middleware blocks, delimited by #region markers so a re-run can UPGRADE them in place
// (e.g. adding the route-WAF hook to an already-wired app) instead of skipping. Keep the markers —
// reconcileBlock() keys off them.
const REQUEST_MIDDLEWARE_BLOCK = [
  '// #region patchstack-guard (managed by patchstack-connect protect — do not edit)',
  '// Browser→Supabase tunnel + response screening; optional route WAF via PATCHSTACK_ROUTE_WAF=1.',
  'const patchstackGuard = createMiddleware().server(async ({ next }) => {',
  '  const request = getRequest();',
  '  if (request) {',
  '    const { pathname } = new URL(request.url);',
  '    if (pathname === GUARD_PATH) return handleGuardRequest(request);',
  '    if (process.env.PATCHSTACK_ROUTE_WAF === "1") {',
  '      const blocked = await guardRequest(request);',
  '      if (blocked) return blocked;',
  '    }',
  '  }',
  '  // The request is passed so route/method-scoped response rules can apply their scope.',
  '  return screenResponse(await next(), request);',
  '});',
  '// #endregion patchstack-guard',
].join('\n');

const FUNCTION_MIDDLEWARE_BLOCK = [
  '// #region patchstack-function-guard (managed by patchstack-connect protect — do not edit)',
  '// Inspect server-function args before they reach the database.',
  'const patchstackFunctionGuard = createMiddleware({ type: "function" }).server(async ({ next, data }) => {',
  '  const blocked = await inspectServerFn(data);',
  '  if (blocked) throw new Error(blocked.message);',
  '  return next();',
  '});',
  '// #endregion patchstack-function-guard',
].join('\n');

// Reconcile a managed block: replace a marked region in place (UPGRADE), migrate a legacy
// (un-marked) block, or insert before `insertBefore` (fresh). Legacy blocks are our own single
// arrow-fn statements whose only line-leading `});` is the terminator, so we bound them from the
// `const` line (plus the comment header immediately above) to that `});`.
function reconcileBlock(s: string, region: string, block: string, legacyConst: string, insertBefore: string): string {
  const lines = s.split('\n');
  const startMarker = `// #region ${region} `;
  const endMarker = `// #endregion ${region}`;
  const si = lines.findIndex((l) => l.includes(startMarker));
  if (si !== -1) {
    const ei = lines.findIndex((l, i) => i > si && l.trim() === endMarker);
    if (ei !== -1) {
      lines.splice(si, ei - si + 1, ...block.split('\n'));
      return lines.join('\n');
    }
  }
  const ci = lines.findIndex((l) => l.includes(legacyConst));
  if (ci !== -1) {
    const close = lines.findIndex((l, i) => i >= ci && l.trim() === '});');
    if (close !== -1) {
      let start = ci;
      while (start > 0 && (lines[start - 1] ?? '').trim().startsWith('//')) start--; // eat old comment header
      lines.splice(start, close - start + 1, ...block.split('\n'));
      return lines.join('\n');
    }
  }
  return s.replace(insertBefore, block + '\n\n' + insertBefore);
}

function detect(cwd: string): boolean {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return false;
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(read(pkgPath));
  } catch {
    return false;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return (
    Boolean(deps['@tanstack/react-start']) &&
    existsSync(join(cwd, 'src/start.ts')) &&
    existsSync(join(cwd, 'src/integrations/supabase/client.ts'))
  );
}

const GUARD_FILE = 'src/integrations/patchstack/guard.ts';

function scaffold(cwd: string, opts: WireOptions): string[] {
  const templates = templatesDir();
  const dst = join(cwd, 'src/integrations/patchstack');
  ensureProjectDirectorySync(cwd, dst);
  const changed: string[] = [];
  if (!existsSync(join(dst, 'guard.ts'))) {
    copyProjectFileSync(cwd, join(templates, 'guard.ts'), join(dst, 'guard.ts'));
    changed.push(GUARD_FILE);
  }
  const rulesDst = join(dst, 'rules.json');
  // Default: the high-precision starter, written only if absent (don't clobber the user's rules on
  // re-run). --demo: (re)seed the broad multi-class sample bundle for a self-contained demonstration.
  if (opts.demo) {
    copyProjectFileSync(cwd, join(templates, 'demo-rules.json'), rulesDst);
    changed.push('src/integrations/patchstack/rules.json');
    log('scaffolded guard.ts + rules.json (demo sample rule set)');
  } else if (!existsSync(rulesDst)) {
    copyProjectFileSync(cwd, join(templates, 'rules.json'), rulesDst);
    changed.push('src/integrations/patchstack/rules.json');
    log('scaffolded guard.ts + rules.json (starter rules)');
  } else {
    log('scaffolded guard.ts (kept existing rules.json)');
  }
  return changed;
}

function patchClient(ts: Compiler, s: string): string | null {
  if (s.includes('x-ps-target')) {
    return s;
  }
  const tree = parsedSource(ts, 'client.ts', s);
  if (!tree) return null;
  const anchors: number[] = [];
  const visit = (node: import('typescript').Node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (call.expression.getText(tree) === 'headers.set'
        && call.arguments[0] && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === 'apikey'
        && call.arguments[1]?.getText(tree) === 'supabaseKey') anchors.push(node.end);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (anchors.length !== 1) return null;
  return s.slice(0, anchors[0]) + '\n' + CLIENT_TUNNEL + s.slice(anchors[0]);
}

function patchStart(ts: Compiler, original: string): string | null {
  let s = original;
  const importAnchor = 'import { createStart, createMiddleware } from "@tanstack/react-start";';
  const exportAnchor = 'export const startInstance';
  const rmAnchor = 'requestMiddleware: [';
  const tree = parsedSource(ts, 'start.ts', s);
  if (!tree) return null;
  const startImport = tree.statements.find(node => ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@tanstack/react-start'
    && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.length === 2
    && node.importClause.namedBindings.elements.every(e => !e.propertyName && !e.isTypeOnly
      && ['createStart', 'createMiddleware'].includes(e.name.text)));
  if (!startImport) return null;
  const declaration = tree.statements.filter(ts.isVariableStatement)
    .filter(node => node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap(node => [...node.declarationList.declarations])
    .find(node => ts.isIdentifier(node.name) && node.name.text === 'startInstance');
  const call = declaration?.initializer;
  if (!call || !ts.isCallExpression(call) || call.expression.getText(tree) !== 'createStart' || call.arguments.length !== 1) return null;
  const factory = call.arguments[0]!;
  if (!ts.isArrowFunction(factory) || factory.parameters.length) return null;
  let config = factory.body;
  while (ts.isParenthesizedExpression(config)) config = config.expression;
  if (!ts.isObjectLiteralExpression(config)) return null;
  if (config.properties.some(p => !ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name))) return null;
  const edits = [{ start: startImport.getStart(tree), end: startImport.end, text: importAnchor }];
  for (const name of ['requestMiddleware', 'functionMiddleware']) {
    const properties = config.properties.filter(p => p.name?.getText(tree) === name);
    if (properties.length > 1 || (name === 'requestMiddleware' && !properties.length)) return null;
    const property = properties[0];
    if (!property || !ts.isPropertyAssignment(property)) continue;
    if (!ts.isArrayLiteralExpression(property.initializer)) return null;
    edits.push({ start: property.getStart(tree), end: property.initializer.getStart(tree) + 1, text: `${name}: [` });
  }
  const guardImports = tree.statements.filter(node => ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@/integrations/patchstack/guard');
  if (guardImports.length > 1) return null;
  const guardImport = guardImports[0];
  if (guardImport) {
    if (!ts.isImportDeclaration(guardImport) || !guardImport.importClause?.namedBindings
      || !ts.isNamedImports(guardImport.importClause.namedBindings)
      || guardImport.importClause.namedBindings.elements.some(e => e.propertyName || e.isTypeOnly
        || !['GUARD_PATH', 'handleGuardRequest', 'inspectServerFn', 'screenResponse', 'guardRequest'].includes(e.name.text))) return null;
    edits.push({ start: guardImport.getStart(tree), end: guardImport.end, text: GUARD_IMPORT });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) s = s.slice(0, edit.start) + edit.text + s.slice(edit.end);
  if (!s.includes(importAnchor) || !s.includes(exportAnchor)) {
    return null;
  }
  if (!s.includes(rmAnchor)) return null;

  // Each step reconciles idempotently: a re-run (including after a connect upgrade) refreshes the
  // managed blocks in place — never duplicates, never leaves a stale version behind.

  // Imports — refresh the managed guard import line wholesale (upgrade), else insert both imports.
  if (GUARD_IMPORT_RE.test(s)) {
    s = s.replace(GUARD_IMPORT_RE, GUARD_IMPORT);
  } else {
    const requestImport = tree.statements.some(node => ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@tanstack/react-start/server'
      && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.some(e => !e.propertyName && e.name.text === 'getRequest'));
    if (!requestImport && /\bgetRequest\b/.test(original)) return null;
    s = s.replace(importAnchor, importAnchor + '\n' + (requestImport ? GUARD_IMPORT : START_IMPORTS));
  }

  // Middleware blocks — upgrade a marked region / migrate a legacy block / insert fresh.
  s = reconcileBlock(s, 'patchstack-guard', REQUEST_MIDDLEWARE_BLOCK, 'const patchstackGuard =', exportAnchor);
  s = reconcileBlock(s, 'patchstack-function-guard', FUNCTION_MIDDLEWARE_BLOCK, 'const patchstackFunctionGuard =', exportAnchor);

  // Register the browser-tunnel guard in requestMiddleware.
  if (s.includes(rmAnchor) && !s.includes('requestMiddleware: [patchstackGuard')) {
    s = s.replace(rmAnchor, rmAnchor + 'patchstackGuard, ');
  }

  // Register the server-function guard in functionMiddleware (create the key if the app has none).
  if (!s.includes('functionMiddleware: [patchstackFunctionGuard')) {
    const fmAnchor = 'functionMiddleware: [';
    if (s.includes(fmAnchor)) {
      s = s.replace(fmAnchor, fmAnchor + 'patchstackFunctionGuard, ');
    } else if (s.includes(rmAnchor)) {
      s = s.replace(rmAnchor, 'functionMiddleware: [patchstackFunctionGuard],\n    ' + rmAnchor);
    }
  }

  return parsedSource(ts, 'start.ts', s) ? s : null;
}

function wire(cwd: string, opts: WireOptions): WireResult {
  const ts = sourceCompiler(cwd);
  const clientPath = join(cwd, 'src/integrations/supabase/client.ts');
  const startPath = join(cwd, 'src/start.ts');
  const oldClient = read(clientPath);
  const oldStart = read(startPath);
  const client = ts && patchClient(ts, oldClient);
  const start = ts && patchStart(ts, oldStart);
  if (!ts || !client || !start || !parsedSource(ts, 'client.ts', client)) {
    log('TanStack wiring needs manual integration: client and server left untouched; no browser traffic was redirected.');
    return { ok: false, changed: [] };
  }
  const changed = scaffold(cwd, opts);
  // In demo mode, keep the local sample rules active — don't bake a site UUID (which would make
  // the guard fetch live Pulse rules instead of the bundled demo set).
  if (!opts.demo && bakeSiteUuid(cwd, GUARD_FILE)) changed.push(GUARD_FILE);
  try {
    if (start !== oldStart) {
      writeProjectFileSync(cwd, startPath, start);
      changed.push('src/start.ts');
    }
    if (client !== oldClient) {
      writeProjectFileSync(cwd, clientPath, client);
      changed.push('src/integrations/supabase/client.ts');
    }
  } catch (error) {
    if (start !== oldStart) writeProjectFileSync(cwd, startPath, oldStart);
    throw error;
  }
  log(
    opts.demo
      ? 'done — guard wired with the demo sample rules (blocks by default). Set PATCHSTACK_MODE=dry-run for log-only.'
      : 'done — guard wired and always-on (blocks by default). Set PATCHSTACK_MODE=dry-run for log-only.',
  );
  return { ok: true, changed: [...new Set(changed)] };
}

function verify(cwd: string): VerifyResult {
  const guardPath = join(cwd, GUARD_FILE);
  const clientPath = join(cwd, 'src/integrations/supabase/client.ts');
  const startPath = join(cwd, 'src/start.ts');
  const guard = existsSync(guardPath) ? read(guardPath) : '';
  const client = existsSync(clientPath) ? read(clientPath) : '';
  const start = existsSync(startPath) ? read(startPath) : '';

  const checks = [
    { label: 'guard.ts scaffolded', ok: guard.length > 0, hint: 'run `patchstack-connect protect`' },
    { label: 'Supabase client tunnels through the guard', ok: client.includes('x-ps-target'), hint: 'run `patchstack-connect protect` to re-patch src/integrations/supabase/client.ts' },
    { label: 'request middleware defined + registered', ok: start.includes('const patchstackGuard =') && start.includes('requestMiddleware: [patchstackGuard'), hint: 'run `patchstack-connect protect` to re-patch src/start.ts' },
    { label: 'server-function middleware defined + registered', ok: start.includes('const patchstackFunctionGuard =') && start.includes('functionMiddleware: [patchstackFunctionGuard'), hint: 'run `patchstack-connect protect` to re-patch src/start.ts' },
  ];
  return { wired: checks.every((c) => c.ok), checks };
}

export const tanstackSupabaseAdapter: Adapter = {
  name: 'tanstack-supabase',
  label: 'TanStack Start + Supabase',
  detect,
  wire,
  verify,
};
