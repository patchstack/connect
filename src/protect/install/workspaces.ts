// Monorepo support for `protect`: a builder like Hostinger Horizons generates a workspace repo whose
// framework app lives in a package (e.g. `apps/web`), while the prompt — and so the setup — runs at the
// root. The root is not the app, so no adapter matches there; the guard has to be wired where the app is.
//
// This resolves the workspace package directories declared in the root `package.json`, so the orchestrator
// can look for an app in each. Dependency-free and best-effort: a repo it cannot read simply has none.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The directories of the packages a root `package.json` declares as workspaces.
 *
 * Handles the two shapes npm/yarn/pnpm-via-package.json use — a bare `workspaces` array and the
 * `{ workspaces: { packages: [...] } }` object — and the patterns that actually appear in builder output:
 * an exact path (`apps/web`) and a single trailing wildcard (`apps/*`, `packages/*`). A deeper glob
 * (`packages/**`) is skipped rather than mis-expanded; it does not occur in the shapes this targets, and
 * guessing at it would wire the wrong directory.
 *
 * Only directories that themselves contain a `package.json` are returned — an empty or stray folder under
 * `apps/` is not a package.
 */
export function workspacePackageDirs(cwd: string): string[] {
  let patterns: unknown;
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      workspaces?: unknown;
    };
    patterns = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : (pkg.workspaces as { packages?: unknown } | undefined)?.packages;
  } catch {
    return [];
  }
  if (!Array.isArray(patterns)) return [];

  const isPackageDir = (dir: string): boolean => {
    try {
      return lstatSync(dir).isDirectory() && existsSync(join(dir, 'package.json'));
    } catch {
      return false;
    }
  };

  const dirs = new Set<string>();
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '') continue;

    if (pattern.endsWith('/*')) {
      const base = join(cwd, pattern.slice(0, -2));
      let entries: string[];
      try {
        entries = readdirSync(base);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        const dir = join(base, name);
        if (isPackageDir(dir)) dirs.add(dir);
      }
    } else if (!pattern.includes('*')) {
      const dir = join(cwd, pattern);
      if (isPackageDir(dir)) dirs.add(dir);
    }
  }

  return [...dirs];
}

/**
 * The workspace root whose site this package belongs to, when `cwd` is a workspace package that records no
 * site of its own and an enclosing workspace root does.
 *
 * Setup records the site at the root of a workspace repo. A command run inside one of its packages
 * (`apps/web`) would otherwise read the package's own config, find no site, and either write its choices
 * where nothing else reads them or provision a second site for the same app. Null when `cwd` names its own
 * site, is not a declared package of an enclosing root, or that root records no site.
 */
export function workspaceRootWithSite(cwd: string): string | null {
  if (siteUuidIn(cwd) !== null) return null;
  const here = realDir(cwd);
  let dir = cwd;
  // Bounded like the guard's own config search.
  for (let i = 0; i < 8; i++) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
    if (siteUuidIn(dir) === null) continue;
    return workspacePackageDirs(dir).some((pkg) => realDir(pkg) === here) ? dir : null;
  }

  return null;
}

const SITE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function siteUuidIn(dir: string): string | null {
  try {
    const uuid: unknown = JSON.parse(readFileSync(join(dir, '.patchstackrc.json'), 'utf8')).siteUuid;
    return typeof uuid === 'string' && SITE_UUID.test(uuid) ? uuid : null;
  } catch {
    return null;
  }
}

function realDir(dir: string): string {
  try {
    return realpathSync(resolve(dir));
  } catch {
    return resolve(dir);
  }
}
