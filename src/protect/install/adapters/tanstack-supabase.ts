// Adapter: TanStack Start + Supabase (the shape Lovable emits).
//
// Wires the always-on guard with zero changes to the user's own code — patches the generated
// Supabase client (browser→Supabase tunnel) and src/start.ts (request + function middleware),
// scaffolds src/integrations/patchstack/{guard.ts,rules.json}, and bakes the site UUID.
// Idempotent + upgrades in place via the managed `#region` blocks.

import { writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { read, log, templatesDir } from '../util.js';
import type { Adapter, WireOptions, WireResult, VerifyResult } from '../types.js';

const CLIENT_TUNNEL = [
  '',
  "    // PATCHSTACK: in the browser, tunnel Supabase traffic through the app's own server guard",
  '    // (same-origin) so payloads are inspected before they reach Supabase.',
  "    if (typeof window !== 'undefined') {",
  "      const target = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);",
  "      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');",
  "      headers.set('x-ps-target', target);",
  "      const guardUrl = new URL('/_patchstack/guard', window.location.origin).toString();",
  '      return fetch(guardUrl, { ...init, method, headers });',
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
  '  return screenResponse(await next());',
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
  mkdirSync(dst, { recursive: true });
  copyFileSync(join(templates, 'guard.ts'), join(dst, 'guard.ts')); // guard.ts is managed — always refreshed
  const changed = [GUARD_FILE];
  const rulesDst = join(dst, 'rules.json');
  // Default: the high-precision starter, written only if absent (don't clobber the user's rules on
  // re-run). --demo: (re)seed the broad multi-class sample bundle for a self-contained demonstration.
  if (opts.demo) {
    copyFileSync(join(templates, 'demo-rules.json'), rulesDst);
    changed.push('src/integrations/patchstack/rules.json');
    log('scaffolded guard.ts + rules.json (demo sample rule set)');
  } else if (!existsSync(rulesDst)) {
    copyFileSync(join(templates, 'rules.json'), rulesDst);
    changed.push('src/integrations/patchstack/rules.json');
    log('scaffolded guard.ts + rules.json (starter rules)');
  } else {
    log('scaffolded guard.ts (kept existing rules.json)');
  }
  return changed;
}

// Bake the site UUID from .patchstackrc.json (written by `scan`) into the scaffolded guard, so the
// deployed Worker calls the live Pulse rules API with zero user config. Left as the inert
// placeholder when the app hasn't been scanned yet or the file can't be read. Returns whether it baked.
function bakeSiteUuid(cwd: string): boolean {
  const rc = join(cwd, '.patchstackrc.json');
  if (!existsSync(rc)) {
    log('no .patchstackrc.json — guard uses PATCHSTACK_SITE_UUID env or the bundled fallback');
    return false;
  }
  let uuid: string | undefined;
  try {
    uuid = JSON.parse(read(rc)).siteUuid;
  } catch {
    log('.patchstackrc.json unreadable — skipping site-UUID bake');
    return false;
  }
  // Guard on UUID format so a malformed value falls through to the inert placeholder rather than
  // baking junk into a TS string literal (broken build / replace-token hazards).
  if (!uuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    log('.patchstackrc.json siteUuid missing or malformed — guard uses PATCHSTACK_SITE_UUID env or the bundled fallback');
    return false;
  }
  const p = join(cwd, GUARD_FILE);
  if (!existsSync(p)) return false;
  const s = read(p);
  if (!s.includes('__PATCHSTACK_SITE_UUID__')) {
    log('guard.ts site UUID already baked');
    return false;
  }
  writeFileSync(p, s.replace('__PATCHSTACK_SITE_UUID__', uuid));
  log('baked site UUID into guard.ts — live rules from the Patchstack API');
  return true;
}

function patchClient(cwd: string): boolean {
  const p = join(cwd, 'src/integrations/supabase/client.ts');
  const s = read(p);
  if (s.includes('x-ps-target')) {
    log('client.ts already wired');
    return false;
  }
  const anchor = "headers.set('apikey', supabaseKey);";
  if (!s.includes(anchor)) {
    log('client.ts anchor not found — skipping (template changed?)');
    return false;
  }
  writeFileSync(p, s.replace(anchor, anchor + '\n' + CLIENT_TUNNEL));
  log('patched client.ts (tunnel Supabase through the guard)');
  return true;
}

function patchStart(cwd: string): boolean {
  const p = join(cwd, 'src/start.ts');
  let s = read(p);
  const importAnchor = 'import { createStart, createMiddleware } from "@tanstack/react-start";';
  const exportAnchor = 'export const startInstance';
  const rmAnchor = 'requestMiddleware: [';
  if (!s.includes(importAnchor) || !s.includes(exportAnchor)) {
    log('start.ts anchors not found — skipping (template changed?)');
    return false;
  }

  // Each step reconciles idempotently: a re-run (including after a connect upgrade) refreshes the
  // managed blocks in place — never duplicates, never leaves a stale version behind.
  const original = s;

  // Imports — refresh the managed guard import line wholesale (upgrade), else insert both imports.
  if (GUARD_IMPORT_RE.test(s)) {
    s = s.replace(GUARD_IMPORT_RE, GUARD_IMPORT);
  } else {
    s = s.replace(importAnchor, importAnchor + '\n' + START_IMPORTS);
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

  if (s === original) {
    log('start.ts already wired');
    return false;
  }
  writeFileSync(p, s);
  log('patched start.ts (guard registered as request + function middleware)');
  return true;
}

function wire(cwd: string, opts: WireOptions): WireResult {
  const changed = scaffold(cwd, opts);
  // In demo mode, keep the local sample rules active — don't bake a site UUID (which would make
  // the guard fetch live Pulse rules instead of the bundled demo set).
  if (!opts.demo && bakeSiteUuid(cwd)) changed.push(GUARD_FILE);
  if (patchClient(cwd)) changed.push('src/integrations/supabase/client.ts');
  if (patchStart(cwd)) changed.push('src/start.ts');
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
