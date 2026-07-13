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

// Guard templates ship next to the built CLI (dist/protect/templates).
const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), 'protect', 'templates');
const APP = process.cwd();
const PS_DIR = join(APP, 'src/integrations/patchstack');

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
  'import { GUARD_PATH, handleGuardRequest, inspectServerFn } from "@/integrations/patchstack/guard";',
].join('\n');

const START_MIDDLEWARE = [
  '',
  '// Patchstack guard (browser tunnel): intercept tunneled Supabase traffic before anything else.',
  'const patchstackGuard = createMiddleware().server(async ({ next }) => {',
  '  const request = getRequest();',
  '  if (request) {',
  '    const { pathname } = new URL(request.url);',
  '    if (pathname === GUARD_PATH) return handleGuardRequest(request);',
  '  }',
  '  return next();',
  '});',
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

function scaffold(cwd: string): void {
  const dst = join(cwd, 'src/integrations/patchstack');
  mkdirSync(dst, { recursive: true });
  copyFileSync(join(TEMPLATES, 'guard.ts'), join(dst, 'guard.ts'));
  copyFileSync(join(TEMPLATES, 'rules.json'), join(dst, 'rules.json'));
  log('scaffolded guard.ts + rules.json');
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
  if (s.includes('patchstackGuard')) return log('start.ts already wired');
  const importAnchor = 'import { createStart, createMiddleware } from "@tanstack/react-start";';
  const exportAnchor = 'export const startInstance';
  const rmAnchor = 'requestMiddleware: [';
  if (!s.includes(importAnchor) || !s.includes(exportAnchor) || !s.includes(rmAnchor)) {
    return log('start.ts anchors not found — skipping (template changed?)');
  }
  s = s.replace(importAnchor, importAnchor + '\n' + START_IMPORTS);
  s = s.replace(exportAnchor, START_MIDDLEWARE + '\n' + exportAnchor);
  // Browser-tunnel guard → request middleware (covers browser-direct Supabase apps).
  s = s.replace(rmAnchor, rmAnchor + 'patchstackGuard, ');
  // Server-function guard → function middleware (covers apps that mutate via server functions).
  const fmAnchor = 'functionMiddleware: [';
  if (s.includes(fmAnchor)) {
    s = s.replace(fmAnchor, fmAnchor + 'patchstackFunctionGuard, ');
  } else {
    // App declared no functionMiddleware — add the key next to requestMiddleware.
    s = s.replace(rmAnchor, 'functionMiddleware: [patchstackFunctionGuard],\n    ' + rmAnchor);
  }
  writeFileSync(p, s);
  log('patched start.ts (guard registered as request + function middleware)');
}

/** Scaffold + wire the runtime guard into the app. */
export function runProtect(cwd: string): void {
  if (!detectSupportedStack(cwd)) {
    log('runtime protection currently supports TanStack Start + Supabase apps; stack not detected — skipping.');
    return;
  }
  scaffold(cwd);
  patchClient(cwd);
  patchStart(cwd);
  log('done — guard wired and always-on (blocks by default). Set PATCHSTACK_MODE=dry-run for log-only.');
}
