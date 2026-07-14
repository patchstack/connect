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
