import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProtect } from '../../src/protect/install.js';

// Scaffolder coverage for `patchstack-connect protect` (runProtect): it must detect a TanStack
// Start + Supabase app, scaffold the guard, and patch client.ts + start.ts at the right anchors —
// including wiring the response-screening middleware — without duplicating on re-run.

// Minimal fixture mirroring the anchors a real Lovable app exposes.
const START_TS = `import { createStart, createMiddleware } from "@tanstack/react-start";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";

const errorMiddleware = createMiddleware().server(async ({ next }) => next());

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [errorMiddleware],
}));
`;

const CLIENT_TS = `import { createClient } from '@supabase/supabase-js';
function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers();
    headers.set('apikey', supabaseKey);
    return fetch(input, { ...init, headers });
  };
}
`;

function makeApp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-protect-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@tanstack/react-start': '^1.0.0' } }));
  mkdirSync(path.join(dir, 'src/integrations/supabase'), { recursive: true });
  writeFileSync(path.join(dir, 'src/start.ts'), START_TS);
  writeFileSync(path.join(dir, 'src/integrations/supabase/client.ts'), CLIENT_TS);
  return dir;
}

const read = (dir: string, rel: string) => readFileSync(path.join(dir, rel), 'utf8');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('runProtect scaffolder', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeApp();
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('scaffolds guard.ts + rules.json', () => {
    runProtect(dir);
    expect(existsSync(path.join(dir, 'src/integrations/patchstack/guard.ts'))).toBe(true);
    const rules = JSON.parse(read(dir, 'src/integrations/patchstack/rules.json'));
    expect(Array.isArray(rules.firewall)).toBe(true);
  });

  it('patches client.ts with the browser tunnel', () => {
    runProtect(dir);
    const client = read(dir, 'src/integrations/supabase/client.ts');
    expect(client).toContain('x-ps-target');
    expect(client).toContain("headers.set('apikey', supabaseKey);"); // anchor preserved
  });

  it('wires both guards + response screening into start.ts, preserving existing middleware', () => {
    runProtect(dir);
    const start = read(dir, 'src/start.ts');
    expect(start).toContain('inspectServerFn');
    expect(start).toContain('screenResponse');
    expect(start).toContain('const patchstackGuard =');
    expect(start).toContain('const patchstackFunctionGuard =');
    // response screening is wired on the non-tunnel path
    expect(start).toContain('return screenResponse(await next());');
    // guards registered FIRST, existing middleware kept
    expect(start).toContain('requestMiddleware: [patchstackGuard, errorMiddleware]');
    expect(start).toContain('functionMiddleware: [patchstackFunctionGuard, attachSupabaseAuth]');
  });

  it('scaffolds a type-safe guard.ts (compiles under a strict TanStack build)', () => {
    runProtect(dir);
    const guard = read(dir, 'src/integrations/patchstack/guard.ts');
    // Regression: a strict `tsc` build in the target app rejected a `string` mode and a
    // `Promise<unknown>` from screenResponse (the middleware return type). Keep both type-safe.
    expect(guard).toContain('const mode: "block" | "dry-run" =');
    expect(guard).toContain('export async function screenResponse<T>(response: T): Promise<T>');
  });

  it('scaffolds the opt-in route-level WAF (gated on PATCHSTACK_ROUTE_WAF)', () => {
    runProtect(dir);
    const start = read(dir, 'src/start.ts');
    const guard = read(dir, 'src/integrations/patchstack/guard.ts');
    expect(start).toContain('process.env.PATCHSTACK_ROUTE_WAF === "1"');
    expect(start).toContain('const blocked = await guardRequest(request);');
    expect(guard).toContain('export async function guardRequest(');
  });

  it('--demo seeds the broad sample rule set and keeps it local (no baked site UUID)', () => {
    writeFileSync(path.join(dir, '.patchstackrc.json'), JSON.stringify({ siteUuid: '123e4567-e89b-12d3-a456-426614174000' }));
    runProtect(dir, { demo: true });
    const ids = JSON.parse(read(dir, 'src/integrations/patchstack/rules.json')).firewall.map((r: any) => r.id);
    expect(ids).toContain('demo-sqli'); // the broad sample bundle
    expect(ids).toContain('demo-egress-blocklist-host');
    // demo keeps the local rules active → the site UUID is NOT baked (else the guard fetches live rules)
    const guard = read(dir, 'src/integrations/patchstack/guard.ts');
    expect(guard).toContain('__PATCHSTACK_SITE_UUID__');
    expect(guard).not.toContain('123e4567-e89b-12d3-a456-426614174000');
  });

  it('default install writes the starter rules and bakes a present site UUID', () => {
    writeFileSync(path.join(dir, '.patchstackrc.json'), JSON.stringify({ siteUuid: '123e4567-e89b-12d3-a456-426614174000' }));
    runProtect(dir);
    const ids = JSON.parse(read(dir, 'src/integrations/patchstack/rules.json')).firewall.map((r: any) => r.id);
    expect(ids.some((id: string) => id.startsWith('ps-fallback-'))).toBe(true);
    const guard = read(dir, 'src/integrations/patchstack/guard.ts');
    expect(guard).toContain('123e4567-e89b-12d3-a456-426614174000'); // baked → live Pulse rules
    expect(guard).not.toContain('__PATCHSTACK_SITE_UUID__');
  });

  it('does not clobber an existing rules.json on a plain re-run', () => {
    runProtect(dir);
    const custom = JSON.stringify({ firewall: [{ id: 'my-custom-rule' }], whitelists: [], whitelist_keys: {} });
    writeFileSync(path.join(dir, 'src/integrations/patchstack/rules.json'), custom);
    runProtect(dir);
    expect(JSON.parse(read(dir, 'src/integrations/patchstack/rules.json')).firewall[0].id).toBe('my-custom-rule');
  });

  it('upgrades a legacy (pre-markers, no route-WAF) start.ts in place', () => {
    // Simulate an app wired by an older published version: un-marked blocks, import lacking
    // guardRequest, and no PATCHSTACK_ROUTE_WAF hook.
    const legacy = `import { createStart, createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { GUARD_PATH, handleGuardRequest, inspectServerFn, screenResponse } from "@/integrations/patchstack/guard";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";

const errorMiddleware = createMiddleware().server(async ({ next }) => next());

// Patchstack guard (browser tunnel): intercept tunneled Supabase traffic before anything else,
// then screen the outgoing response (SSR HTML / data) for leaked secrets & PII.
const patchstackGuard = createMiddleware().server(async ({ next }) => {
  const request = getRequest();
  if (request) {
    const { pathname } = new URL(request.url);
    if (pathname === GUARD_PATH) return handleGuardRequest(request);
  }
  return screenResponse(await next());
});

// Patchstack guard (server functions): inspect server-fn args before they reach the database.
const patchstackFunctionGuard = createMiddleware({ type: "function" }).server(async ({ next, data }) => {
  const blocked = await inspectServerFn(data);
  if (blocked) throw new Error(blocked.message);
  return next();
});

export const startInstance = createStart(() => ({
  functionMiddleware: [patchstackFunctionGuard, attachSupabaseAuth],
  requestMiddleware: [patchstackGuard, errorMiddleware],
}));
`;
    writeFileSync(path.join(dir, 'src/start.ts'), legacy);
    runProtect(dir);
    const start = read(dir, 'src/start.ts');
    // upgraded in place: route-WAF hook + guardRequest import now present, wrapped in markers
    expect(start).toContain('// #region patchstack-guard ');
    expect(start).toContain('process.env.PATCHSTACK_ROUTE_WAF === "1"');
    expect(start).toContain('const blocked = await guardRequest(request);');
    expect(start).toMatch(/import \{[^}]*guardRequest[^}]*\} from "@\/integrations\/patchstack\/guard";/);
    // no duplication, old comment header gone, registrations intact
    expect(count(start, 'const patchstackGuard =')).toBe(1);
    expect(count(start, 'const patchstackFunctionGuard =')).toBe(1);
    expect(start).not.toContain('intercept tunneled Supabase traffic before anything else');
    expect(start).toContain('requestMiddleware: [patchstackGuard, errorMiddleware]');
    // and a second run is a no-op
    const twice = () => runProtect(dir);
    twice();
    expect(count(read(dir, 'src/start.ts'), 'const patchstackGuard =')).toBe(1);
  });

  it('is idempotent — re-running does not duplicate wiring', () => {
    runProtect(dir);
    runProtect(dir);
    const start = read(dir, 'src/start.ts');
    const client = read(dir, 'src/integrations/supabase/client.ts');
    expect(count(start, 'const patchstackGuard =')).toBe(1);
    expect(count(start, 'const patchstackFunctionGuard =')).toBe(1);
    expect(count(start, 'patchstackGuard, errorMiddleware')).toBe(1);
    expect(count(client, 'x-ps-target')).toBe(1);
  });

  it('skips an unsupported stack (no @tanstack/react-start)', () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'ps-plain-'));
    writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }));
    runProtect(plain);
    expect(existsSync(path.join(plain, 'src/integrations/patchstack/guard.ts'))).toBe(false);
    rmSync(plain, { recursive: true, force: true });
  });
});
