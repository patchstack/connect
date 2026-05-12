import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PatchstackError, type PackageEntry } from '../types.js';

interface LockfileV2Package {
  name?: string;
  version?: string;
  link?: boolean;
  resolved?: string;
}

interface LockfileV2 {
  lockfileVersion: number;
  packages?: Record<string, LockfileV2Package>;
  dependencies?: Record<string, LockfileV1Dependency>;
}

interface LockfileV1Dependency {
  version: string;
  dependencies?: Record<string, LockfileV1Dependency>;
}

export async function parseNpmLockfile(lockfilePath: string): Promise<PackageEntry[]> {
  let raw: string;
  try {
    raw = await readFile(lockfilePath, 'utf8');
  } catch (cause) {
    throw new PatchstackError(`Could not read lockfile at ${lockfilePath}`, 'LOCKFILE_NOT_FOUND', cause);
  }

  let parsed: LockfileV2;
  try {
    parsed = JSON.parse(raw) as LockfileV2;
  } catch (cause) {
    throw new PatchstackError(`Lockfile at ${lockfilePath} is not valid JSON`, 'LOCKFILE_PARSE_ERROR', cause);
  }

  if (parsed.packages) {
    return extractFromV2(parsed.packages);
  }

  if (parsed.dependencies) {
    return extractFromV1(parsed.dependencies);
  }

  throw new PatchstackError(
    `Lockfile at ${lockfilePath} has no "packages" or "dependencies" key`,
    'LOCKFILE_PARSE_ERROR',
  );
}

function extractFromV2(packages: Record<string, LockfileV2Package>): PackageEntry[] {
  const entries: PackageEntry[] = [];

  for (const [pkgPath, pkg] of Object.entries(packages)) {
    if (pkgPath === '') {
      continue;
    }
    if (pkg.link === true) {
      continue;
    }
    if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
      continue;
    }

    const name = pkg.name ?? extractNameFromPath(pkgPath);
    if (name === null) {
      continue;
    }

    entries.push({
      name,
      version: pkg.version,
      path: pkgPath,
      direct: isDirectV2(pkgPath),
    });
  }

  return entries;
}

function extractFromV1(
  deps: Record<string, LockfileV1Dependency>,
  acc: PackageEntry[] = [],
  depth = 0,
): PackageEntry[] {
  for (const [name, dep] of Object.entries(deps)) {
    if (typeof dep.version === 'string' && dep.version.length > 0) {
      acc.push({ name, version: dep.version, direct: depth === 0 });
    }
    if (dep.dependencies) {
      extractFromV1(dep.dependencies, acc, depth + 1);
    }
  }
  return acc;
}

function extractNameFromPath(pkgPath: string): string | null {
  const segments = pkgPath.split('node_modules' + path.sep === pkgPath ? path.sep : '/');
  const parts = pkgPath.split('/');
  const nmIndex = parts.lastIndexOf('node_modules');
  if (nmIndex === -1 || nmIndex >= parts.length - 1) {
    return segments[segments.length - 1] ?? null;
  }
  const tail = parts.slice(nmIndex + 1);
  if (tail.length === 0) {
    return null;
  }
  const first = tail[0];
  if (first !== undefined && first.startsWith('@') && tail.length >= 2) {
    return `${first}/${tail[1]}`;
  }
  return first ?? null;
}

function isDirectV2(pkgPath: string): boolean {
  const parts = pkgPath.split('/');
  const nmCount = parts.filter((p) => p === 'node_modules').length;
  return nmCount === 1;
}
