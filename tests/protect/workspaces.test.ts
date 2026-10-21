import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProtect, runVerify } from '../../src/protect/install/index.js';
import { workspacePackageDirs } from '../../src/protect/install/workspaces.js';

// `protect` run at a monorepo root must wire the guard into the workspace package that holds the app — the
// shape Hostinger Horizons generates (an `apps/web` React Router app under a bare workspace root). The
// prompt, and so setup, run at the root; the root is not the app, so the guard has to be placed where the
// app is, carrying the site UUID the root's `.patchstackrc.json` recorded.

const UUID = '556d8930-ae4d-4bf2-bee8-3bc53c096876';
const dirs: string[] = [];

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A workspace repo with a React Router app in `apps/web` and a site UUID provisioned at the root. */
function makeMonorepo(opts: { rc?: boolean } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ps-mono-'));
  dirs.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'monorepo-ssr', private: true, type: 'module', workspaces: ['apps/*'],
    devDependencies: { '@patchstack/connect': '^0.5.57' },
  }));
  if (opts.rc !== false) writeFileSync(path.join(root, '.patchstackrc.json'), JSON.stringify({ siteUuid: UUID }));
  mkdirSync(path.join(root, 'apps/web/app'), { recursive: true });
  writeFileSync(path.join(root, 'apps/web/package.json'), JSON.stringify({
    name: 'web', type: 'module',
    dependencies: { 'react-router': '^7.6.0' },
    devDependencies: { '@react-router/dev': '^7.6.0', '@react-router/serve': '^7.6.0' },
  }));
  writeFileSync(path.join(root, 'apps/web/app/root.tsx'),
    'import { Outlet } from "react-router";\nexport default function Root() { return <Outlet />; }\n');
  return root;
}

const read = (root: string, rel: string) => readFileSync(path.join(root, rel), 'utf8');

describe('protect in a workspace monorepo', () => {
  it('wires the guard into the workspace app, not a generic scaffold at the root', () => {
    const root = makeMonorepo();

    const result = runProtect(root);

    expect(result.status).toBe('wired');
    // No generic guard left at the root, where the app would never load it.
    expect(existsSync(path.join(root, 'patchstack/guard.js'))).toBe(false);
    // The React Router seam is wired inside the workspace package.
    expect(existsSync(path.join(root, 'apps/web/app/patchstack/guard.server.ts'))).toBe(true);
    expect(read(root, 'apps/web/app/root.tsx')).toContain('patchstackRootMiddleware');
    // Changed files are reported relative to the root the command ran in.
    if (result.status === 'wired') {
      expect(result.changed).toContain('apps/web/app/root.tsx');
      expect(result.adapter).toContain('apps/web');
    }
  });

  it('bakes the site UUID the root provisioned into the workspace guard', () => {
    const root = makeMonorepo();
    runProtect(root);
    expect(read(root, 'apps/web/app/patchstack/guard.server.ts')).toContain(`"${UUID}"`);
  });

  it('reports the workspace app as wired from the root (protect --check)', () => {
    const root = makeMonorepo();
    runProtect(root);

    const report = runVerify(root);
    expect(report.wired).toBe(true);
    expect(report.stack).toBe('React Router');
  });

  it('leaves the guard uninstalled (and no UUID baked) when nothing provisioned a site', () => {
    const root = makeMonorepo({ rc: false });
    runProtect(root);
    // Still wired — protection does not depend on the credential — but the UUID falls back to the env var.
    expect(read(root, 'apps/web/app/root.tsx')).toContain('patchstackRootMiddleware');
    expect(read(root, 'apps/web/app/patchstack/guard.server.ts')).toContain('__PATCHSTACK_SITE_UUID__');
  });
});

describe('workspacePackageDirs', () => {
  function makeRoot(workspaces: unknown, packages: string[]): string {
    const root = mkdtempSync(path.join(tmpdir(), 'ps-ws-'));
    dirs.push(root);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces }));
    for (const pkg of packages) {
      mkdirSync(path.join(root, pkg), { recursive: true });
      writeFileSync(path.join(root, pkg, 'package.json'), JSON.stringify({ name: pkg }));
    }
    return root;
  }

  it('expands a single trailing wildcard (apps/*)', () => {
    const root = makeRoot(['apps/*'], ['apps/web', 'apps/admin']);
    expect(workspacePackageDirs(root).map((d) => path.relative(root, d)).sort()).toEqual(['apps/admin', 'apps/web']);
  });

  it('accepts the object form ({ packages: [...] }) and exact paths', () => {
    const root = makeRoot({ packages: ['packages/ui'] }, ['packages/ui']);
    expect(workspacePackageDirs(root).map((d) => path.relative(root, d))).toEqual(['packages/ui']);
  });

  it('skips folders that are not packages and deeper globs it cannot safely expand', () => {
    const root = makeRoot(['apps/*', 'libs/**'], ['apps/web']);
    mkdirSync(path.join(root, 'apps/empty'), { recursive: true }); // no package.json → not a package
    expect(workspacePackageDirs(root).map((d) => path.relative(root, d))).toEqual(['apps/web']);
  });

  it('returns nothing for a project with no workspaces', () => {
    const root = makeRoot(undefined, []);
    expect(workspacePackageDirs(root)).toEqual([]);
  });
});
