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
  for (const group of ['dependencies', 'devDependencies'] as const) {
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
