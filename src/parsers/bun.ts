import { readFile } from 'node:fs/promises';
import { PatchstackError, type PackageEntry } from '../types.js';

/**
 * Parses `bun.lock` — Bun's text lockfile — without a JSON5 dependency.
 *
 * Reading the lockfile matters more here than for the other package managers, because Bun's isolated
 * layout defeats a `node_modules` walk entirely: packages live under a dot-directory and the top level is
 * symlinks into it, so a walker that skips dotfiles and symlinks (both correct on their own — one avoids
 * caches, the other avoids symlink cycles) finds nothing at all and reports a project with no packages.
 * Isolated is the default for new workspaces, so that is not an edge case.
 *
 * The file is JSON with trailing commas, which `JSON.parse` rejects. Rather than take a parser dependency
 * for one file, the commas are stripped with a string-aware pass; anything else in the file is ordinary
 * JSON.
 *
 * ## Shape
 *
 * ```
 * "packages": {
 *   "lodash": ["lodash@4.17.21", "", {}, "sha512-…"],
 *   "@scope/pkg": ["@scope/pkg@1.2.3", "", {}, "sha512-…"],
 * }
 * ```
 *
 * The first element is the resolved descriptor. Entries whose descriptor is not a registry version —
 * `workspace:`, `file:`, a git URL — are skipped: they are not registry packages, and inventing a version
 * for them would put something in a vulnerability inventory that no advisory can ever match.
 */
export async function parseBunLockfile(lockfilePath: string): Promise<PackageEntry[]> {
  let raw: string;
  try {
    raw = await readFile(lockfilePath, 'utf8');
  } catch (cause) {
    throw new PatchstackError(`Could not read lockfile at ${lockfilePath}`, 'LOCKFILE_NOT_FOUND', cause);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(raw));
  } catch (cause) {
    throw new PatchstackError(`Lockfile at ${lockfilePath} is not valid JSON`, 'LOCKFILE_PARSE_ERROR', cause);
  }

  const packages = (parsed as { packages?: unknown } | null)?.packages;
  if (typeof packages !== 'object' || packages === null) {
    throw new PatchstackError(`Lockfile at ${lockfilePath} has no "packages" entries`, 'LOCKFILE_PARSE_ERROR');
  }

  const direct = directDependencyNames(parsed);
  const entries: PackageEntry[] = [];
  let skipped = 0;

  for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
    const descriptor = Array.isArray(value) ? value[0] : value;
    if (typeof descriptor !== 'string') {
      skipped++;
      continue;
    }

    const split = splitDescriptor(descriptor);
    if (split === null) {
      skipped++;
      continue;
    }

    // A workspace key can be a path rather than a package name (`"packages/api"`), so the name comes from
    // the descriptor. The key is what the file is indexed by, not what the package is called.
    entries.push({
      name: split.name,
      version: split.version,
      ...(direct.has(split.name) ? { direct: true } : {}),
      ...(key === split.name ? {} : { path: key }),
    });
  }

  if (entries.length === 0) {
    throw new PatchstackError(
      `Lockfile at ${lockfilePath} lists no registry packages${skipped > 0 ? ` (${skipped} non-registry entr${skipped === 1 ? 'y' : 'ies'} skipped)` : ''}`,
      'LOCKFILE_PARSE_ERROR',
    );
  }

  return entries;
}

/**
 * `name@version` split on the LAST `@`, so a scoped name keeps its leading one.
 *
 * Returns null when the version is not a registry version. `workspace:`, `file:`, `link:` and git or URL
 * descriptors all resolve to something that is installed but is not a published release, and a
 * vulnerability inventory that carried them would be naming things no advisory can match.
 */
function splitDescriptor(descriptor: string): { name: string; version: string } | null {
  const at = descriptor.lastIndexOf('@');
  if (at <= 0) return null;

  const name = descriptor.slice(0, at);
  const version = descriptor.slice(at + 1);
  if (name === '' || version === '') return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(version)) return null; // a protocol, not a version
  if (version.includes('/')) return null; // a URL or path

  return { name, version };
}

/**
 * Names declared as direct dependencies by any workspace in the file.
 *
 * Used only to mark entries; a name that cannot be resolved here just goes unmarked.
 */
function directDependencyNames(parsed: unknown): Set<string> {
  const names = new Set<string>();
  const workspaces = (parsed as { workspaces?: unknown } | null)?.workspaces;
  if (typeof workspaces !== 'object' || workspaces === null) return names;

  for (const workspace of Object.values(workspaces as Record<string, unknown>)) {
    if (typeof workspace !== 'object' || workspace === null) continue;
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = (workspace as Record<string, unknown>)[group];
      if (typeof deps !== 'object' || deps === null) continue;
      for (const name of Object.keys(deps as Record<string, unknown>)) names.add(name);
    }
  }

  return names;
}

/**
 * Remove trailing commas before `}` or `]`, leaving anything inside a string alone.
 *
 * The only difference between this file and JSON. Done by hand rather than with a regex because a regex
 * cannot tell a comma in a string from a comma in the structure, and integrity hashes are strings full of
 * characters that look structural.
 */
function stripTrailingCommas(source: string): string {
  const out: string[] = [];
  let inString = false;
  let pendingComma = -1; // index in `out` of a comma not yet known to be trailing

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;

    if (inString) {
      out.push(ch);
      if (ch === '\\') {
        const next = source[i + 1];
        if (next !== undefined) {
          out.push(next);
          i++;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      pendingComma = -1;
      out.push(ch);
      continue;
    }

    if (ch === ',') {
      pendingComma = out.length;
      out.push(ch);
      continue;
    }

    if (ch === '}' || ch === ']') {
      if (pendingComma !== -1) out[pendingComma] = ' ';
      pendingComma = -1;
      out.push(ch);
      continue;
    }

    // Whitespace between a comma and the closing bracket keeps the comma pending; anything else settles it.
    if (!/\s/.test(ch)) pendingComma = -1;
    out.push(ch);
  }

  return out.join('');
}
