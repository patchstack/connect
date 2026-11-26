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
/**
 * A dependency package.json declares. `aliasOf` is the package an npm alias (`"zod4": "npm:zod@^4"`)
 * installs: the lockfile and the installed tree name it by its own name, not by the key it is declared
 * under, so either name in a source means the dependency is there.
 */
export interface DeclaredDependency {
  name: string;
  aliasOf?: string;
}

/** The package an `npm:` alias specifier installs, or null for any other specifier. */
function aliasTarget(spec: unknown): string | null {
  if (typeof spec !== 'string' || !spec.startsWith('npm:')) return null;
  const target = spec.slice('npm:'.length);
  const versionAt = target.lastIndexOf('@');
  const name = versionAt > 0 ? target.slice(0, versionAt) : target;
  return name.length > 0 ? name : null;
}

export async function readDeclaredDependencyNames(cwd: string): Promise<string[]> {
  return (await readDeclaredDependencies(cwd)).map((dependency) => dependency.name);
}

export async function readDeclaredDependencies(cwd: string): Promise<DeclaredDependency[]> {
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

  const declared = new Map<string, DeclaredDependency>();
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
      const aliasOf = aliasTarget(spec);
      declared.set(name, aliasOf !== null && aliasOf !== name ? { name, aliasOf } : { name });
    }
  }

  return [...declared.values()];
}

/**
 * Declared names absent from a parsed package set. A non-empty result means
 * the source predates package.json — the fossil-lockfile failure mode where
 * e.g. `npm install` planted a package-lock.json once and the platform's
 * native package manager (bun on Lovable) never updates it again.
 */
export function missingDependencies(declared: Array<string | DeclaredDependency>, packages: PackageEntry[]): string[] {
  const present = new Set(packages.map((entry) => entry.name));
  return declared
    .map((dependency) => (typeof dependency === 'string' ? { name: dependency } : dependency))
    .filter(({ name, aliasOf }: DeclaredDependency) => !present.has(name) && !(aliasOf !== undefined && present.has(aliasOf)))
    .map(({ name }) => name);
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
