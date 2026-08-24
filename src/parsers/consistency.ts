import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PackageEntry } from '../types.js';

/**
 * Registry-installable dependency names declared in package.json
 * (dependencies + devDependencies). Non-registry specifiers (file:, link:,
 * workspace:, portal:) are excluded — lockfile parsers skip those too, so
 * their absence from a parsed set says nothing about staleness. Returns []
 * when package.json is missing or unreadable (nothing to validate against).
 */
export async function readDeclaredDependencyNames(cwd: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(cwd, 'package.json'), 'utf8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }

  const names = new Set<string>();
  // `optionalDependencies` included: they are installed when the platform supports them, they can be
  // vulnerable, and leaving them out meant a lockfile that omitted one still read as complete.
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const deps = (parsed as Record<string, unknown>)[group];
    if (typeof deps !== 'object' || deps === null) {
      continue;
    }
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec === 'string' && /^(file|link|workspace|portal):/.test(spec)) {
        continue;
      }
      names.add(name);
    }
  }

  return [...names];
}

/**
 * Declared names absent from a parsed package set. A non-empty result means
 * the source predates package.json — the fossil-lockfile failure mode where
 * e.g. `npm install` planted a package-lock.json once and the platform's
 * native package manager (bun on Lovable) never updates it again.
 */
export function missingDependencies(declared: string[], packages: PackageEntry[]): string[] {
  const present = new Set(packages.map((entry) => entry.name));
  return declared.filter((name) => !present.has(name));
}

/**
 * Packages two sources both list at DIFFERENT versions.
 *
 * A name check cannot see this, and the version is what decides whether a package is vulnerable: a stale
 * lockfile naming every dependency looks complete while reporting the versions of an older install. It
 * fails in both directions — an old version reported for a patched install raises a finding that is not
 * real, and a new version reported for an old install hides one that is.
 *
 * Only direct-name collisions are compared. A package present in one source and absent from the other is
 * not a disagreement about a version; it is a difference in what got installed, which the staleness check
 * above is for.
 */
export function disagreements(
  packages: PackageEntry[],
  other: PackageEntry[],
): Array<{ name: string; version: string; otherVersion: string }> {
  const otherVersions = new Map<string, string>();
  for (const entry of other) {
    // First occurrence wins, mirroring how a lockfile's own top-level entry precedes nested copies. A
    // package installed at two versions in one tree is not a disagreement BETWEEN sources.
    if (!otherVersions.has(entry.name)) otherVersions.set(entry.name, entry.version);
  }

  const seen = new Set<string>();
  const conflicts: Array<{ name: string; version: string; otherVersion: string }> = [];

  for (const entry of packages) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);

    const otherVersion = otherVersions.get(entry.name);
    if (otherVersion !== undefined && otherVersion !== entry.version) {
      conflicts.push({ name: entry.name, version: entry.version, otherVersion });
    }
  }

  return conflicts;
}
