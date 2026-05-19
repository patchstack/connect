import { readFile } from 'node:fs/promises';
import { PatchstackError, type PackageEntry } from '../types.js';

/**
 * Parses pnpm-lock.yaml without pulling in a YAML library. We don't need full
 * YAML semantics — only the `packages:` block (the canonical list of every
 * installed package) and, for direct-dep marking, the dependency sections under
 * `importers:` (v9+) or at the top level (v6-v8 single-project).
 *
 * Supported pnpm-lock key formats:
 *   v5:    /pkg/1.0.0                /@scope/pkg/1.0.0
 *   v6-v8: /pkg@1.0.0                /@scope/pkg@1.0.0     (optional `(peer@x)` suffix)
 *   v9:    pkg@1.0.0                 @scope/pkg@1.0.0      (optional `(peer@x)` suffix, may be quoted)
 */
export async function parsePnpmLockfile(lockfilePath: string): Promise<PackageEntry[]> {
  let raw: string;
  try {
    raw = await readFile(lockfilePath, 'utf8');
  } catch (cause) {
    throw new PatchstackError(
      `Could not read lockfile at ${lockfilePath}`,
      'LOCKFILE_NOT_FOUND',
      cause,
    );
  }

  const lines = raw.split(/\r?\n/);
  const directNames = collectDirectDepNames(lines);
  const packageKeys = collectPackagesBlockKeys(lines);

  if (packageKeys.length === 0) {
    throw new PatchstackError(
      `Lockfile at ${lockfilePath} has no "packages" entries`,
      'LOCKFILE_PARSE_ERROR',
    );
  }

  const entries: PackageEntry[] = [];
  for (const key of packageKeys) {
    const parsed = parsePackageKey(key);
    if (parsed === null) {
      continue;
    }
    entries.push({
      name: parsed.name,
      version: parsed.version,
      direct: directNames.has(parsed.name),
    });
  }

  return entries;
}

interface ParsedKey {
  name: string;
  version: string;
}

export function parsePackageKey(rawKey: string): ParsedKey | null {
  let k = rawKey.trim();
  if (k.length === 0) {
    return null;
  }

  if (
    (k.startsWith("'") && k.endsWith("'")) ||
    (k.startsWith('"') && k.endsWith('"'))
  ) {
    k = k.slice(1, -1);
  }

  if (k.startsWith('/')) {
    k = k.slice(1);
  }

  // Strip peer-dependency suffix used by v6+: `pkg@1.0.0(peer@1.0.0)(other@2)`.
  const parenIdx = k.indexOf('(');
  if (parenIdx >= 0) {
    k = k.slice(0, parenIdx);
  }

  // Split off the optional `@scope/` prefix so the remaining "body" contains
  // exactly one separator between the bare name and the version. npm forbids
  // both `@` and `/` inside the bare-name portion, so the first occurrence of
  // either character in the body is unambiguously the name/version separator.
  let scopePrefix = '';
  let body = k;
  if (k.startsWith('@')) {
    const firstSlash = k.indexOf('/');
    if (firstSlash <= 0) {
      return null;
    }
    scopePrefix = k.slice(0, firstSlash + 1);
    body = k.slice(firstSlash + 1);
  }

  const slashIdx = body.indexOf('/');
  const atIdx = body.indexOf('@');

  let sepIdx: number;
  if (slashIdx < 0 && atIdx < 0) {
    return null;
  } else if (slashIdx < 0) {
    sepIdx = atIdx;
  } else if (atIdx < 0) {
    sepIdx = slashIdx;
  } else {
    sepIdx = Math.min(slashIdx, atIdx);
  }

  const name = scopePrefix + body.slice(0, sepIdx);
  let version = body.slice(sepIdx + 1);

  // v5 peer suffix uses `_`: `1.0.0_react@18.2.0`.
  const underscoreIdx = version.indexOf('_');
  if (underscoreIdx >= 0) {
    version = version.slice(0, underscoreIdx);
  }

  if (name.length === 0 || version.length === 0) {
    return null;
  }

  return { name, version };
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') {
    i++;
  }
  return i;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith('#');
}

/**
 * Collects keys directly nested under the top-level `packages:` block. Stops
 * when another top-level key (e.g. `snapshots:`) appears.
 */
function collectPackagesBlockKeys(lines: string[]): string[] {
  const keys: string[] = [];
  let inBlock = false;
  let childIndent: number | null = null;

  for (const line of lines) {
    if (isBlankOrComment(line)) {
      continue;
    }

    const indent = indentOf(line);

    if (!inBlock) {
      if (indent === 0 && line.trim() === 'packages:') {
        inBlock = true;
      }
      continue;
    }

    if (indent === 0) {
      break;
    }

    if (childIndent === null) {
      childIndent = indent;
    }

    if (indent !== childIndent) {
      continue;
    }

    const content = line.slice(indent);
    if (!content.endsWith(':')) {
      continue;
    }

    keys.push(content.slice(0, -1));
  }

  return keys;
}

/**
 * Collects direct dependency names. Looks in two places, since the format
 * differs across lockfile versions and workspaces:
 *
 *   1. `importers:` > `<importer>:` > `{dependencies,devDependencies,optionalDependencies}:`
 *      (v9 always, v6-v8 in workspaces)
 *   2. Top-level `{dependencies,devDependencies,optionalDependencies}:`
 *      (v6-v8 single-project lockfiles)
 *
 * Direct-dep marking is best-effort: a name absent from both is simply left as
 * not-direct, matching the npm parser's behaviour for transitive packages.
 */
function collectDirectDepNames(lines: string[]): Set<string> {
  const names = new Set<string>();
  collectFromImporters(lines, names);
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    collectFromTopLevelSection(lines, section, names);
  }
  return names;
}

const DEP_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
]);

function collectFromImporters(lines: string[], out: Set<string>): void {
  let inImporters = false;
  let importerIndent: number | null = null;
  let inDepSection = false;
  let depSectionIndent: number | null = null;
  let leafIndent: number | null = null;

  for (const line of lines) {
    if (isBlankOrComment(line)) {
      continue;
    }
    const indent = indentOf(line);
    const trimmed = line.trim();

    if (!inImporters) {
      if (indent === 0 && trimmed === 'importers:') {
        inImporters = true;
      }
      continue;
    }

    if (indent === 0) {
      break;
    }

    // Track the indent at which importer entries (e.g. `.:`, `packages/foo:`) sit.
    if (importerIndent === null) {
      importerIndent = indent;
    }

    if (indent === importerIndent) {
      inDepSection = false;
      depSectionIndent = null;
      leafIndent = null;
      continue;
    }

    if (!inDepSection) {
      const key = stripTrailingColon(trimmed);
      if (key !== null && DEP_SECTIONS.has(key)) {
        inDepSection = true;
        depSectionIndent = indent;
      }
      continue;
    }

    if (depSectionIndent !== null && indent <= depSectionIndent) {
      // Reset — we've exited the dep section. Reconsider this line.
      inDepSection = false;
      depSectionIndent = null;
      leafIndent = null;
      const key = stripTrailingColon(trimmed);
      if (key !== null && DEP_SECTIONS.has(key)) {
        inDepSection = true;
        depSectionIndent = indent;
      }
      continue;
    }

    if (leafIndent === null) {
      leafIndent = indent;
    }

    if (indent !== leafIndent) {
      continue;
    }

    const name = extractLeafName(trimmed);
    if (name !== null) {
      out.add(name);
    }
  }
}

function collectFromTopLevelSection(
  lines: string[],
  section: string,
  out: Set<string>,
): void {
  let inSection = false;
  let leafIndent: number | null = null;

  for (const line of lines) {
    if (isBlankOrComment(line)) {
      continue;
    }
    const indent = indentOf(line);
    const trimmed = line.trim();

    if (!inSection) {
      if (indent === 0 && trimmed === `${section}:`) {
        inSection = true;
      }
      continue;
    }

    if (indent === 0) {
      break;
    }

    if (leafIndent === null) {
      leafIndent = indent;
    }

    if (indent !== leafIndent) {
      continue;
    }

    const name = extractLeafName(trimmed);
    if (name !== null) {
      out.add(name);
    }
  }
}

function stripTrailingColon(s: string): string | null {
  if (!s.endsWith(':')) {
    return null;
  }
  return s.slice(0, -1).trim();
}

/**
 * Extracts the package name from a dependency-section leaf, handling both the
 * short form (`pkg: 1.0.0`) and the v9 expanded form (`pkg:` followed by
 * `specifier:` / `version:` children). Quoted scoped names like `'@scope/pkg':`
 * are unquoted.
 */
function extractLeafName(trimmed: string): string | null {
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx < 0) {
    return null;
  }
  let name = trimmed.slice(0, colonIdx).trim();
  if (name.length === 0) {
    return null;
  }
  if (
    (name.startsWith("'") && name.endsWith("'")) ||
    (name.startsWith('"') && name.endsWith('"'))
  ) {
    name = name.slice(1, -1);
  }
  return name.length > 0 ? name : null;
}
