// `patchstack-connect protect` — installs the runtime guard into a TanStack Start + Supabase app.
//
// "Add Patchstack" already installs the connector; this wires the always-on guard so exploit
// requests against known-vulnerable packages are blocked, with zero changes to the user's own
// code. Idempotent (safe to re-run).
//
// The engine ships inside @patchstack/connect (exported as @patchstack/connect/protect), so the
// scaffolded guard just imports it — no extra dependency, no local manifest. Rules come from the
// Patchstack API at runtime (cached), with a bundled fallback until a token is configured.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard templates ship next to the built CLI (dist/protect/templates). Resolve for both the
// built layout (install.ts is bundled into dist/cli.js at the dist root → protect/templates) and
// the source layout (install.ts lives in src/protect/ → templates is a sibling).
const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES =
  [join(HERE, 'protect', 'templates'), join(HERE, 'templates')].find((p) => existsSync(p)) ??
  join(HERE, 'protect', 'templates');
const read = (p: string) => readFileSync(p, 'utf8');
const log = (msg: string) => console.log(`patchstack protect: ${msg}`);

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

const START_IMPORTS = [
  'import { getRequest } from "@tanstack/react-start/server";',
  'import { GUARD_PATH, handleGuardRequest, inspectServerFn, screenResponse, guardRequest } from "@/integrations/patchstack/guard";',
].join('\n');

const REQUEST_MIDDLEWARE_DEF = [
  '',
  '// Patchstack guard (browser tunnel): intercept tunneled Supabase traffic before anything else,',
  '// then screen the outgoing response (SSR HTML / data) for leaked secrets & PII.',
  'const patchstackGuard = createMiddleware().server(async ({ next }) => {',
  '  const request = getRequest();',
  '  if (request) {',
  '    const { pathname } = new URL(request.url);',
  '    if (pathname === GUARD_PATH) return handleGuardRequest(request);',
  '    // Optional route-level WAF: screen every request and 403 on a match. Opt-in via',
  '    // PATCHSTACK_ROUTE_WAF=1 (runs the request rules on all traffic — classic-WAF FP surface).',
  '    if (process.env.PATCHSTACK_ROUTE_WAF === "1") {',
  '      const blocked = await guardRequest(request);',
  '      if (blocked) return blocked;',
  '    }',
  '  }',
  '  return screenResponse(await next());',
  '});',
  '',
].join('\n');

const FUNCTION_MIDDLEWARE_DEF = [
  '',
  '// Patchstack guard (server functions): inspect server-fn args before they reach the database,',
  '// covering apps that mutate via TanStack server functions (which bypass the browser tunnel).',
  'const patchstackFunctionGuard = createMiddleware({ type: "function" }).server(async ({ next, data }) => {',
  '  const blocked = await inspectServerFn(data);',
  '  if (blocked) throw new Error(blocked.message);',
  '  return next();',
  '});',
  '',
].join('\n');

export function detectSupportedStack(cwd: string): boolean {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(read(pkgPath));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return (
    Boolean(deps['@tanstack/react-start']) &&
    existsSync(join(cwd, 'src/start.ts')) &&
    existsSync(join(cwd, 'src/integrations/supabase/client.ts'))
  );
}

function scaffold(cwd: string, opts: { demo?: boolean } = {}): void {
  const dst = join(cwd, 'src/integrations/patchstack');
  mkdirSync(dst, { recursive: true });
  copyFileSync(join(TEMPLATES, 'guard.ts'), join(dst, 'guard.ts')); // guard.ts is managed — always refreshed
  const rulesDst = join(dst, 'rules.json');
  // Default: the high-precision starter, written only if absent (don't clobber the user's rules on
  // re-run). --demo: (re)seed the broad multi-class sample bundle for a self-contained demonstration.
  if (opts.demo) {
    copyFileSync(join(TEMPLATES, 'demo-rules.json'), rulesDst);
    log('scaffolded guard.ts + rules.json (demo sample rule set)');
  } else if (!existsSync(rulesDst)) {
    copyFileSync(join(TEMPLATES, 'rules.json'), rulesDst);
    log('scaffolded guard.ts + rules.json (starter rules)');
  } else {
    log('scaffolded guard.ts (kept existing rules.json)');
  }
}

// Bake the site UUID from .patchstackrc.json (written by `patchstack-connect scan`) into the
// scaffolded guard, so the deployed Worker calls the live Pulse rules API with zero user config.
// Left as the inert placeholder (guard falls back to PATCHSTACK_SITE_UUID env / bundled rules)
// when the app hasn't been scanned yet or the file can't be read.
function bakeSiteUuid(cwd: string): void {
  const rc = join(cwd, '.patchstackrc.json');
  if (!existsSync(rc)) return log('no .patchstackrc.json — guard uses PATCHSTACK_SITE_UUID env or the bundled fallback');
  let uuid: string | undefined;
  try {
    uuid = JSON.parse(read(rc)).siteUuid;
  } catch {
    return log('.patchstackrc.json unreadable — skipping site-UUID bake');
  }
  // Guard on UUID format so a malformed value falls through to the inert placeholder rather
  // than baking junk into a TS string literal (broken build / replace-token hazards).
  if (!uuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    return log('.patchstackrc.json siteUuid missing or malformed — guard uses PATCHSTACK_SITE_UUID env or the bundled fallback');
  }
  const p = join(cwd, 'src/integrations/patchstack/guard.ts');
  if (!existsSync(p)) return;
  const s = read(p);
  if (!s.includes('__PATCHSTACK_SITE_UUID__')) return log('guard.ts site UUID already baked');
  writeFileSync(p, s.replace('__PATCHSTACK_SITE_UUID__', uuid));
  log('baked site UUID into guard.ts — live rules from the Patchstack API');
}

function patchClient(cwd: string): void {
  const p = join(cwd, 'src/integrations/supabase/client.ts');
  let s = read(p);
  if (s.includes('x-ps-target')) return log('client.ts already wired');
  const anchor = "headers.set('apikey', supabaseKey);";
  if (!s.includes(anchor)) return log('client.ts anchor not found — skipping (template changed?)');
  writeFileSync(p, s.replace(anchor, anchor + '\n' + CLIENT_TUNNEL));
  log('patched client.ts (tunnel Supabase through the guard)');
}

function patchStart(cwd: string): void {
  const p = join(cwd, 'src/start.ts');
  let s = read(p);
  const importAnchor = 'import { createStart, createMiddleware } from "@tanstack/react-start";';
  const exportAnchor = 'export const startInstance';
  const rmAnchor = 'requestMiddleware: [';
  if (!s.includes(importAnchor) || !s.includes(exportAnchor)) {
    return log('start.ts anchors not found — skipping (template changed?)');
  }

  // Each step is independently idempotent, so re-running `protect` (including after a connect
  // upgrade that adds a new guard) reconciles only what's missing — never duplicates, never
  // silently skips a newly-added piece.
  const original = s;

  // Imports.
  if (!s.includes('@/integrations/patchstack/guard')) {
    s = s.replace(importAnchor, importAnchor + '\n' + START_IMPORTS);
  } else if (!s.includes('inspectServerFn')) {
    // Upgrade from a build that only wired the browser tunnel: pull in inspectServerFn.
    s = s.replace(
      'import { GUARD_PATH, handleGuardRequest } from "@/integrations/patchstack/guard";',
      'import { GUARD_PATH, handleGuardRequest, inspectServerFn } from "@/integrations/patchstack/guard";',
    );
  }

  // Middleware definitions (each only if its const isn't already present).
  if (!s.includes('const patchstackGuard =')) {
    s = s.replace(exportAnchor, REQUEST_MIDDLEWARE_DEF + '\n' + exportAnchor);
  }
  if (!s.includes('const patchstackFunctionGuard =')) {
    s = s.replace(exportAnchor, FUNCTION_MIDDLEWARE_DEF + '\n' + exportAnchor);
  }

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

  if (s === original) return log('start.ts already wired');
  writeFileSync(p, s);
  log('patched start.ts (guard registered as request + function middleware)');
}

/** Scaffold + wire the runtime guard into the app. */
export function runProtect(cwd: string, opts: { demo?: boolean } = {}): void {
  if (!detectSupportedStack(cwd)) {
    log('runtime protection currently supports TanStack Start + Supabase apps; stack not detected — skipping.');
    return;
  }
  scaffold(cwd, opts);
  // In demo mode, keep the local sample rules active — don't bake a site UUID (which would make the
  // guard fetch live Pulse rules instead of the bundled demo set).
  if (!opts.demo) bakeSiteUuid(cwd);
  patchClient(cwd);
  patchStart(cwd);
  log(
    opts.demo
      ? 'done — guard wired with the demo sample rules (blocks by default). Set PATCHSTACK_MODE=dry-run for log-only.'
      : 'done — guard wired and always-on (blocks by default). Set PATCHSTACK_MODE=dry-run for log-only.',
  );
}
