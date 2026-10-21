import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  middlewareFlagFor,
  ensureMiddlewareFlagEnabled,
  hasMiddlewareFlag,
} from '../../src/protect/install/react-router-middleware.js';
import { reactRouterAdapter } from '../../src/protect/install/adapters/react-router.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ps-rr-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const read = (root: string, rel: string) => readFileSync(path.join(root, rel), 'utf8');
const CONFIG = 'import type { Config } from "@react-router/dev/config";\nexport default {\n  ssr: true,\n} satisfies Config;\n';

describe('middlewareFlagFor (version → flag)', () => {
  it('reads the exact installed version first (7.9 → v8_middleware)', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { 'react-router': '^7.0.0' } }),
      'node_modules/react-router/package.json': JSON.stringify({ name: 'react-router', version: '7.9.3' }),
    });
    expect(middlewareFlagFor(root)).toBe('v8_middleware');
  });

  it('falls back to the declared range when nothing is installed (7.7 → unstable_middleware)', () => {
    const root = project({ 'package.json': JSON.stringify({ devDependencies: { '@react-router/dev': '^7.7.0' } }) });
    expect(middlewareFlagFor(root)).toBe('unstable_middleware');
  });

  it('needs no flag on v8 (middleware is the default)', () => {
    const root = project({ 'package.json': JSON.stringify({ dependencies: { 'react-router': '^8.0.0' } }) });
    expect(middlewareFlagFor(root)).toBeNull();
  });

  it('returns null when the version cannot be determined (never guesses a flag name)', () => {
    const root = project({ 'package.json': JSON.stringify({ dependencies: {} }) });
    expect(middlewareFlagFor(root)).toBeNull();
  });
});

describe('ensureMiddlewareFlagEnabled (config editing)', () => {
  it('adds a future block to a plain `satisfies Config` export', () => {
    const root = project({ 'react-router.config.ts': CONFIG });
    expect(ensureMiddlewareFlagEnabled(root, 'unstable_middleware')).toBe('enabled');
    const out = read(root, 'react-router.config.ts');
    expect(out).toContain('future: { unstable_middleware: true }');
    expect(out).toContain('ssr: true'); // existing config preserved
  });

  it('adds the flag inside an existing future block', () => {
    const root = project({
      'react-router.config.ts': 'export default {\n  future: { v8_middleware: false },\n  ssr: true,\n};\n',
    });
    expect(ensureMiddlewareFlagEnabled(root, 'unstable_middleware')).toBe('enabled');
    expect(read(root, 'react-router.config.ts')).toContain('unstable_middleware: true');
  });

  it('is idempotent when the flag is already set', () => {
    const root = project({
      'react-router.config.ts': 'export default {\n  future: { unstable_middleware: true },\n};\n',
    });
    expect(ensureMiddlewareFlagEnabled(root, 'unstable_middleware')).toBe('already');
  });

  it('edits a defineConfig(...) wrapper', () => {
    const root = project({
      'react-router.config.ts': 'import { defineConfig } from "x";\nexport default defineConfig({ ssr: true });\n',
    });
    expect(ensureMiddlewareFlagEnabled(root, 'v8_middleware')).toBe('enabled');
    expect(read(root, 'react-router.config.ts')).toContain('v8_middleware: true');
  });

  it('reports no-config when there is no react-router.config file', () => {
    const root = project({ 'package.json': '{}' });
    expect(ensureMiddlewareFlagEnabled(root, 'unstable_middleware')).toBe('no-config');
  });

  it('declines a config it cannot edit blind (a factory function export)', () => {
    const root = project({
      'react-router.config.ts': 'export default () => ({ ssr: true });\n',
    });
    expect(ensureMiddlewareFlagEnabled(root, 'unstable_middleware')).toBe('manual');
  });

  it('produces a config the flag check then recognises', () => {
    const root = project({ 'react-router.config.ts': CONFIG });
    ensureMiddlewareFlagEnabled(root, 'unstable_middleware');
    expect(hasMiddlewareFlag(root, 'unstable_middleware')).toBe(true);
    expect(hasMiddlewareFlag(root, 'v8_middleware')).toBe(false);
  });
});

describe('the react-router adapter turns the flag on when it wires the guard', () => {
  function rrApp(): string {
    return project({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'react-router': '^7.7.0' }, devDependencies: { '@react-router/dev': '^7.7.0' } }),
      '.patchstackrc.json': JSON.stringify({ siteUuid: '9cc1c674-2df0-4f60-849d-9968e32a7dac' }),
      'react-router.config.ts': CONFIG,
      'app/root.tsx': 'import { Outlet } from "react-router";\nexport default function Root() { return <Outlet />; }\n',
    });
  }

  it('enables the flag and reports wired', () => {
    const root = rrApp();
    const result = reactRouterAdapter.wire(root, {});
    expect(result.ok).toBe(true);
    expect(result.changed).toContain('react-router.config.ts');
    expect(read(root, 'react-router.config.ts')).toContain('unstable_middleware: true');
    expect(reactRouterAdapter.verify(root).wired).toBe(true);
  });

  it('verify fails (guard would not run) when the middleware flag is missing', () => {
    const root = rrApp();
    reactRouterAdapter.wire(root, {});
    // Simulate a config the adapter could not edit: strip the flag back out.
    writeFileSync(path.join(root, 'react-router.config.ts'), CONFIG);
    const report = reactRouterAdapter.verify(root);
    expect(report.wired).toBe(false);
    expect(report.checks.some((c) => c.label.includes('middleware enabled') && !c.ok)).toBe(true);
  });
});
