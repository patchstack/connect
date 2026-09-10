// Writing the input map's identity into the guard's own rules file, before bundling.
//
// The runtime cannot reconstruct the source map for itself. `map --upload` derives the value from the
// policy content it sends and writes it into a file that is already committed and already imported by
// every scaffolded guard — which is what carries it across the bundler into the running app.
//
// Why that file rather than a new one. It exists, so there is no case where an import resolves to
// nothing and the build breaks. It is already an object holding non-rule metadata beside the bundle, so
// a reserved key follows its own convention. It is not the file live refreshes write — those go to the
// runtime cache directory — so a stamp there survives. And it means the fourteen seam templates are
// untouched: a generated guard already passes this object as `rules`, so it already carries the stamp.
//
// The write is conditional in both directions. A prebuild scan removes a previous stamp before a map is
// produced; a later `map --upload` in that pre-bundle lifecycle writes the new document identity. Leaving
// A retained value would let a later build present an identity its coordinates did not earn.

import { chmodSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { BUILD_STAMP_KEY, hasRawBuildStamp, readBuildStamp } from './build-id.js';
import { stripComments } from './protect/install/source-scope.js';

/** File names a scaffolded guard imports its bundle from. */
const RULES_FILE_NAMES = new Set(['rules.json', 'patchstack.rules.json']);

/** Never walked: dependencies, build output, and anything hidden. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'tmp', 'vendor']);

/** Deep enough for `src/integrations/patchstack/rules.json`, shallow enough not to be a project scan. */
const MAX_DEPTH = 6;
const GUARD_SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const MAX_GUARD_SOURCE_BYTES = 1024 * 1024;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does a regular sibling source file import this bundle into the public protection runtime?
 *
 * The bundle's shape is validation, not ownership: another policy engine can use the same three keys.
 * The scaffolded guard is the authority because it names both this package and this exact co-located
 * file. Symlinked and unusually large sources are not read by a build hook.
 */
function guardImportsRulesFile(dir: string, rulesName: string): boolean {
  const quotedRules = `["']\\./${escapeRegExp(rulesName)}["']`;
  const importsRules = new RegExp(`(?:\\bfrom\\s*|\\brequire\\s*\\(\\s*|\\bnew\\s+URL\\s*\\(\\s*)${quotedRules}`);

  let siblings: string[];
  try {
    siblings = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of siblings) {
    if (!GUARD_SOURCE.test(name)) continue;
    const path = join(dir, name);
    try {
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_GUARD_SOURCE_BYTES) continue;
      const source = stripComments(readFileSync(path, 'utf8'));
      if (source.includes('@patchstack/connect/protect') && importsRules.test(source)) return true;
    } catch {
      // This sibling cannot establish ownership of the bundle.
    }
  }

  return false;
}

/**
 * Is this parsed JSON one of ours?
 *
 * Shape validates the file after a scaffolded guard has established that it imports it. Shape alone is
 * not ownership: another policy engine may use the same keys.
 */
function isRuleBundle(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;

  return (
    Array.isArray(record.firewall) &&
    Array.isArray(record.whitelists) &&
    record.whitelist_keys !== null &&
    typeof record.whitelist_keys === 'object'
  );
}

export type RulesFileLocation =
  | { kind: 'one'; path: string }
  /** No guard is installed here, so there is nothing to stamp and nothing to create. */
  | { kind: 'none' }
  /**
   * A file named like a bundle that could not be parsed.
   *
   * Kept apart from `none` for the diagnostic: a project whose only guard file is corrupt is not an
   * unprotected project, and saying so would send someone looking for the wrong problem.
   */
  | { kind: 'unreadable'; paths: string[] }
  /** More than one candidate. Stamping a guess is worse than stamping nothing. */
  | { kind: 'ambiguous'; paths: string[] };

/**
 * The rules file the installed guard imports.
 *
 * Bounded and tied to the installed guard rather than a glob: the sibling source must import both the
 * public protection runtime and this exact rules file. Where more than one candidate is found the answer
 * is `ambiguous` and nothing is written — a stamp in the wrong file is invisible and would make a later
 * mismatch unexplainable.
 *
 * A project with no guard gets `none`. This never creates the file: an unprotected project has no
 * bundle to stamp, and writing one would be this package scaffolding a guard nobody asked for.
 */
export function findRulesFile(cwd: string): RulesFileLocation {
  const found: string[] = [];
  const unreadable: string[] = [];

  // The real project root, so containment is checked against where the project actually IS rather than
  // against the path text used to reach it.
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return { kind: 'none' };
  }

  /** Inside the project on the REAL path, not merely reachable from it. */
  const contained = (path: string): boolean => {
    try {
      const real = realpathSync(path);

      return real === root || real.startsWith(root + sep);
    } catch {
      return false;
    }
  };

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || found.length > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const path = join(dir, name);
      let entry: ReturnType<typeof lstatSync>;
      try {
        // `lstat`, not `stat`: a symlink is not followed at all. Following one walks out of the project
        // — a linked directory is enough to reach an unrelated `rules.json` and write into it — and a
        // file the project merely points at is not the file the project's guard imports.
        entry = lstatSync(path);
      } catch {
        continue; // vanished mid-walk
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(name)) walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !RULES_FILE_NAMES.has(name)) continue;
      // Belt and braces: even with no symlink on the way here, the chosen file has to resolve inside
      // the project before anything writes to it.
      if (!contained(path)) continue;
      if (!guardImportsRulesFile(dir, name)) continue;
      try {
        if (isRuleBundle(JSON.parse(readFileSync(path, 'utf8')))) found.push(path);
      } catch {
        // Named like ours and not parseable. Recorded, so the caller can say that rather than saying
        // this project has no guard.
        unreadable.push(path);
      }
    }
  };
  walk(cwd, 0);

  if (found.length > 1) return { kind: 'ambiguous', paths: found.map((p) => relative(cwd, p)) };
  if (found.length === 1) return { kind: 'one', path: found[0]! };
  if (unreadable.length > 0) return { kind: 'unreadable', paths: unreadable.map((p) => relative(cwd, p)) };

  return { kind: 'none' };
}

export type StampOutcome =
  | { kind: 'stamped'; file: string; id: string }
  /** A previous stamp was removed because this build has no identity to put there. */
  | { kind: 'cleared'; file: string }
  | { kind: 'unchanged'; file: string }
  /** Nothing was written, and why. Never an error: a build must not fail over this. */
  | { kind: 'skipped'; reason: string };

/**
 * The indentation the file already uses.
 *
 * Indentation style and the presence of a trailing newline are carried over; nothing else is. The file
 * is re-serialised, so CRLF line endings, number spelling, and any other formatting a person chose are
 * normalised to what `JSON.stringify` emits. That is the honest limit of this — preserving a document
 * byte-for-byte would mean patching the metadata surgically rather than round-tripping the object.
 */
function detectIndent(text: string): string | number {
  const match = /\n([ \t]+)"/.exec(text);
  if (match === null) return 0;
  const whitespace = match[1]!;

  return whitespace.includes('\t') ? '\t' : whitespace.length;
}

/**
 * Write `id` into the guard's rules file, or remove any stamp when `id` is null.
 *
 * Corrupt JSON is left exactly as it is. Replacing it with a fresh bundle would discard whatever the
 * app had — possibly rules it is relying on — to fix a field that only affects whether pinned rules may
 * enforce. Reporting that stamping was unavailable is the proportionate answer.
 *
 * Idempotent: a build whose identity has not changed rewrites nothing, so a committed file does not
 * churn on every local build.
 */
export function applyBuildStamp(cwd: string, id: string | null): StampOutcome {
  const location = findRulesFile(cwd);
  if (location.kind === 'none') return { kind: 'skipped', reason: 'no guard rules file in this project' };
  if (location.kind === 'unreadable') {
    return { kind: 'skipped', reason: `${location.paths.join(', ')} is not valid JSON — left untouched` };
  }
  if (location.kind === 'ambiguous') {
    return {
      kind: 'skipped',
      reason: `more than one candidate guard rules file (${location.paths.join(', ')}) — none was stamped`,
    };
  }

  const file = relative(cwd, location.path);
  let text: string;
  try {
    text = readFileSync(location.path, 'utf8');
  } catch (err) {
    return { kind: 'skipped', reason: `${file} could not be read (${(err as Error).message})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'skipped', reason: `${file} is not valid JSON — left untouched` };
  }
  if (!isRuleBundle(parsed)) return { kind: 'skipped', reason: `${file} is not a guard rules bundle` };

  const bundle = parsed as Record<string, unknown>;
  const current = readBuildStamp(bundle);
  // Clearing keys off the RAW property, not the canonical reading of it. A malformed `build_id` reads as
  // null, so comparing canonical values would call a file that still carries `"deadbee"` unchanged and
  // leave it there — a stamp this build did not earn, surviving into the artifact.
  if (id === null ? !hasRawBuildStamp(bundle) : current === id) return { kind: 'unchanged', file };

  const namespace = { ...((bundle[BUILD_STAMP_KEY] ?? {}) as Record<string, unknown>) };
  if (id === null) delete namespace.build_id;
  else namespace.build_id = id;

  if (Object.keys(namespace).length === 0) delete bundle[BUILD_STAMP_KEY];
  else bundle[BUILD_STAMP_KEY] = namespace;

  const serialised = JSON.stringify(bundle, null, detectIndent(text)) + (text.endsWith('\n') ? '\n' : '');
  // Written beside the destination and renamed over it. `writeFileSync` truncates first, so a failure
  // part-way through would leave the project's committed rules file corrupt — and this function reports
  // rather than throws, so the build would carry on with a broken guard bundle. A rename within one
  // directory replaces the file or does nothing.
  const temporary = `${location.path}.patchstack-${process.pid}.tmp`;
  try {
    // Renaming a newly created file also replaces the destination's metadata. Carry its mode onto the
    // sibling first so stamping a committed file cannot make it more permissive or flip its executable bit.
    const mode = lstatSync(location.path).mode & 0o7777;
    writeFileSync(temporary, serialised, { encoding: 'utf8', mode });
    chmodSync(temporary, mode); // creation applies the process umask; restore the exact original mode
    renameSync(temporary, location.path);
  } catch (err) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to clean up, or nothing that can be.
    }

    return { kind: 'skipped', reason: `${file} could not be written (${(err as Error).message})` };
  }

  return id === null ? { kind: 'cleared', file } : { kind: 'stamped', file, id };
}
