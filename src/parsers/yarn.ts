import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PatchstackError, type PackageEntry } from '../types.js';

/**
 * Parses yarn.lock (yarn classic v1 and yarn berry v2+) without a YAML
 * dependency. Both generations share the same block structure — a top-level
 * mapping of comma-separated descriptor lists to a block containing a
 * `version` field — so we walk them with the same scanner and only branch on
 * the `version` syntax (`version "x"` for v1, `version: x` for berry).
 *
 * Direct vs transitive can't be derived from yarn.lock alone (yarn does not
 * record an importer manifest the way pnpm v9 does), so we cross-reference
 * the sibling `package.json` when present.
 */
export async function parseYarnLockfile(lockfilePath: string): Promise<PackageEntry[]> {
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

  const blocks = parseBlocks(raw);
  if (blocks.length === 0) {
    throw new PatchstackError(
      `Lockfile at ${lockfilePath} contains no package entries`,
      'LOCKFILE_PARSE_ERROR',
    );
  }

  const directNames = await readDirectDepNames(path.dirname(lockfilePath));

  const entries: PackageEntry[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.version.length === 0 || block.names.size === 0) {
      continue;
    }
    for (const name of block.names) {
      const dedupKey = `${name}@${block.version}`;
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);
      entries.push({
        name,
        version: block.version,
        direct: directNames.has(name),
      });
    }
  }

  return entries;
}

interface Block {
  names: Set<string>;
  version: string;
}

function parseBlocks(raw: string): Block[] {
  const lines = raw.split(/\r?\n/);
  const blocks: Block[] = [];
  let current: Block | null = null;

  const finalize = () => {
    if (current !== null && current.version.length > 0 && current.names.size > 0) {
      blocks.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const indent = countLeadingSpaces(line);

    if (indent === 0) {
      finalize();
      if (!trimmed.endsWith(':')) {
        continue;
      }
      // `__metadata:` (yarn berry header) has no `@` in any descriptor and
      // produces an empty names set, so it's naturally skipped on finalize.
      const keyLine = trimmed.slice(0, -1);
      const names = new Set<string>();
      for (const spec of splitDescriptors(keyLine)) {
        const name = extractName(spec);
        if (name !== null) {
          names.add(name);
        }
      }
      current = { names, version: '' };
      continue;
    }

    if (current === null) {
      continue;
    }

    const version = parseVersionField(trimmed);
    if (version !== null) {
      current.version = version;
    }
  }

  finalize();
  return blocks;
}

function countLeadingSpaces(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') {
    i++;
  }
  return i;
}

/**
 * Splits a yarn descriptor key list on top-level commas. yarn quotes any
 * descriptor that contains characters needing escaping, so we respect quotes
 * while splitting to avoid breaking on commas inside (rare in practice but
 * cheap to handle).
 */
export function splitDescriptors(keyLine: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < keyLine.length; i++) {
    const c = keyLine[i];
    if (quote !== null) {
      current += c;
      if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === ',') {
      const piece = current.trim();
      if (piece.length > 0) {
        parts.push(piece);
      }
      current = '';
      continue;
    }
    current += c;
  }
  const tail = current.trim();
  if (tail.length > 0) {
    parts.push(tail);
  }
  return parts;
}

/**
 * Protocols in a Berry descriptor that mean the entry is not a published registry package.
 *
 * `workspace:` is a local package in this repository; `patch:`, `virtual:` and `portal:` wrap another
 * descriptor; `file:`, `link:` and `exec:` point at the disk. None of them names something an advisory can
 * be about, and each of them puts an `@` in the range — so splitting on the last `@` treats part of the
 * range as part of the NAME and produces an entry naming a thing that does not exist.
 */
const NON_REGISTRY_PROTOCOLS = /^(?:workspace|patch|virtual|portal|file|link|exec|git|github|https?|ssh):/i;

/**
 * The package name from a yarn descriptor, or null when the descriptor is not a registry package.
 *
 * Handles `axios@^1.6.0`, `"@scope/pkg@^2.1.0"` and `"@scope/pkg@npm:2.1.0"`. The range is discarded — the
 * resolved version comes from the block's `version` field.
 *
 * Two things it must not do. It must not split inside a range: a Berry descriptor's range can contain `@`
 * of its own (`lodash@patch:lodash@npm%3A4.17.20#…`), and the last `@` is then inside the range. And it
 * must not report a non-registry entry as a package at all, because the resulting name is not one.
 *
 * An alias (`alias@npm:real@1.2.3`) resolves to the REAL package: that is what is installed, and what an
 * advisory would be about. The alias is what the app imports it by, which is not this inventory's question.
 */
export function extractName(rawSpec: string): string | null {
  let s = rawSpec.trim();
  if (s.length === 0) {
    return null;
  }
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }

  // Split at the FIRST `@` that starts a range, not the last character that happens to be one. A scope's
  // leading `@` is at position 0 and never a separator.
  const atIdx = s.indexOf('@', 1);
  if (atIdx <= 0) {
    return null;
  }

  const name = s.slice(0, atIdx);
  const range = s.slice(atIdx + 1);
  if (name.length === 0) {
    return null;
  }

  if (NON_REGISTRY_PROTOCOLS.test(range)) {
    return null;
  }

  // `npm:` is the registry protocol, and it is the one place a second package name appears: an alias points
  // at the package actually installed, which is the one an advisory can be about.
  const alias = /^npm:(.+)$/i.exec(range);
  if (alias !== null) {
    const target = alias[1] ?? '';
    // `npm:1.2.3` is a plain version for THIS package; `npm:other@1.2.3` renames another one.
    const targetAt = target.indexOf('@', 1);

    return targetAt > 0 ? target.slice(0, targetAt) : name;
  }

  return name;
}

function parseVersionField(content: string): string | null {
  if (!content.startsWith('version')) {
    return null;
  }
  const after = content.slice('version'.length);
  // yarn v1: `version "1.2.3"` (whitespace then quoted)
  // yarn berry: `version: 1.2.3` or `version: "1.2.3"`
  const firstChar = after.charAt(0);
  if (firstChar !== ' ' && firstChar !== '\t' && firstChar !== ':') {
    return null;
  }
  let rest = firstChar === ':' ? after.slice(1) : after;
  rest = rest.trim();
  if (rest.length === 0) {
    return null;
  }
  if (
    (rest.startsWith('"') && rest.endsWith('"')) ||
    (rest.startsWith("'") && rest.endsWith("'"))
  ) {
    rest = rest.slice(1, -1);
  }
  return rest.length > 0 ? rest : null;
}

async function readDirectDepNames(cwd: string): Promise<Set<string>> {
  const names = new Set<string>();
  let raw: string;
  try {
    raw = await readFile(path.join(cwd, 'package.json'), 'utf8');
  } catch {
    return names;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return names;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return names;
  }
  const obj = parsed as Record<string, unknown>;

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const section = obj[field];
    if (typeof section !== 'object' || section === null) {
      continue;
    }
    for (const name of Object.keys(section)) {
      names.add(name);
    }
  }

  return names;
}
