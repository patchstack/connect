// Where in a source file it is safe to add a top-level binding, and whether the file still parses after.
//
// The installer edits somebody else's entry file. Two things it has to get right, and neither is about
// finding the right line to look like: the binding must land at MODULE scope, and the file must still be
// valid afterwards. A binding placed inside a function is not in scope where the registration runs, so the
// app throws on the first request — or, worse, the framework swallows it and every request goes unscreened
// while the install and the verification both report the guard wired.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** An import statement, or a `const x = require(...)` binding. Matched only at the start of a line. */
const IMPORT_LINE = /^\s*(?:import\b|export\s+(?:\*|\{)|(?:const|let|var)\s+[^=]+=\s*require\()/;

/**
 * The last line carrying a top-level import or require, or -1 when the file has none.
 *
 * Depth-aware, which is the whole point: a `require()` inside a helper looks exactly like a top-level one
 * to a line-by-line scan, and inserting after it puts the guard binding inside that helper.
 *
 * The depth is counted over braces, brackets and parens outside strings, template literals and comments.
 * That is not a parser and does not need to be — it needs to answer one question, "is this line inside
 * anything", and it answers it for any file whose brackets balance. A file whose brackets do not balance
 * does not parse either, and the caller refuses to edit it.
 */
export function lastTopLevelImportLine(source: string): number {
  const lines = source.split('\n');
  let depth = 0;
  let last = -1;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Judged at the depth the line STARTS at: a line opening a function body is itself top level.
    if (!inBlockComment && depth === 0 && IMPORT_LINE.test(line)) last = i;

    inBlockComment = advanceDepth(line, inBlockComment, (delta) => {
      depth += delta;
    });
    if (depth < 0) return -1; // unbalanced; the caller must not edit this file
  }

  return depth === 0 ? last : -1;
}

/**
 * Whether a line index sits at module scope.
 *
 * Used to check what a file ALREADY has, where the line is known and the question is only whether it is
 * nested — a registration statement inside a route handler, for instance.
 */
export function isTopLevelLine(source: string, index: number): boolean {
  const lines = source.split('\n');
  let depth = 0;
  let inBlockComment = false;

  for (let i = 0; i < lines.length && i < index; i++) {
    inBlockComment = advanceDepth(lines[i] ?? '', inBlockComment, (delta) => {
      depth += delta;
    });
  }

  return depth === 0;
}

/**
 * Is `callIndex` in the same block as `appIndex`, and after it?
 *
 * The registration cannot be required at module scope: for some frameworks the app instance only exists
 * inside an async bootstrap function, so that is where the registration belongs. What it must not be is in a
 * DIFFERENT function from the instance it registers on — which is the same class of mistake as a nested
 * import, and just as invisible to a text search.
 *
 * Same block, not merely same depth: leaving the app's block and entering another one at the same depth
 * would match on depth alone, and that is a different scope.
 */
export function inSameBlockAfter(source: string, appIndex: number, callIndex: number): boolean {
  if (appIndex < 0 || callIndex <= appIndex) return false;

  const lines = source.split('\n');
  let depth = 0;
  let inBlockComment = false;

  for (let i = appIndex; i < callIndex; i++) {
    inBlockComment = advanceDepth(lines[i] ?? '', inBlockComment, (delta) => {
      depth += delta;
    });
    // Dropping below the app's own depth means the block it was declared in has closed.
    if (depth < 0) return false;
  }

  return depth === 0;
}

/**
 * Track bracket depth across one line, skipping strings and comments.
 *
 * Returns whether a block comment is still open at the end of the line.
 */
function advanceDepth(line: string, inBlockComment: boolean, add: (delta: number) => void): boolean {
  let quote: string | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    const next = line[i + 1];

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (quote !== null) {
      if (ch === '\\') {
        i++; // escaped character — never a terminator
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '/' && next === '/') return inBlockComment; // rest of the line is a comment
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }

    if (ch === '{' || ch === '(' || ch === '[') add(1);
    else if (ch === '}' || ch === ')' || ch === ']') add(-1);
  }

  return inBlockComment;
}

/**
 * Does this file still parse?
 *
 * `node --check` on the file we just wrote, which is a real parse by the engine that will run it — not a
 * heuristic, and available wherever this CLI runs. Returns null when the check cannot be performed, which
 * is not the same as passing: TypeScript needs a compiler this package must not require of a consumer
 * project, so a `.ts` entry is edited on the strength of the scope check alone and says so.
 *
 * @returns true when it parses, false when it does not, null when nothing could be checked
 */
export function parses(filePath: string): boolean | null {
  if (!/\.(?:js|cjs|mjs)$/.test(filePath)) return null;

  try {
    execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });

    return true;
  } catch (error) {
    // A non-zero exit is a syntax error. Anything else — no `process.execPath`, a sandbox that refuses to
    // spawn — is the check being unavailable, and reporting that as a broken file would abandon a correct
    // edit.
    return isSyntaxError(error) ? false : null;
  }
}

function isSyntaxError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;

  return typeof status === 'number' && status !== 0;
}

/**
 * Source with comments blanked out, line numbering intact.
 *
 * Every question this module answers is about code that RUNS, and a comment is the cheapest way to put a
 * name in a file without running anything. Newlines are kept — including those inside a block comment — so
 * a line index taken from the stripped text still points at the same line of the original.
 *
 * String-aware: a `//` inside a URL literal is not a comment, and treating it as one would blank the rest
 * of a line that might hold the real import.
 */
export function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      } else if (ch === '\n') {
        out += ch;
      }
      continue;
    }
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        if (next !== undefined) {
          out += next;
          i++;
        }
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }

  return out;
}

/** The character a masked string literal's contents are replaced with. Never appears in real source. */
export const MASKED_CHAR = '\u0001';

/**
 * Source with the CONTENTS of every string literal blanked, character for character.
 *
 * `stripComments` deliberately keeps strings — a `//` inside a URL is not a comment — which leaves one way
 * back in: a string is a place to put code-shaped text that never runs. A literal holding
 * `import { protectFetch } from "./patchstack/guard"`, and another holding `protectFetch(`, satisfy any
 * check that searches text without knowing where that text is.
 *
 * Blanked rather than removed, one character for one character, so the result is the same length as the
 * input: an offset or a line index taken from the masked text addresses the same place in the original,
 * which is how a real declaration's module specifier is read back out. Newlines inside template literals
 * are kept for the same reason.
 */
export function maskStringContents(source: string): string {
  let out = '';
  let quote: string | null = null;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;

    if (quote === null) {
      out += ch;
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      continue;
    }

    if (ch === '\\') {
      // The escape and the character it escapes are both content, and neither ends the literal.
      out += MASKED_CHAR;
      if (i + 1 < source.length) {
        out += source[i + 1] === '\n' ? '\n' : MASKED_CHAR;
        i++;
      }
      continue;
    }
    if (ch === quote) {
      out += ch;
      quote = null;
      continue;
    }
    out += ch === '\n' ? '\n' : MASKED_CHAR;
  }

  return out;
}

// --- which module a specifier names -------------------------------------------------------------

/** The file names the scaffolder gives a guard, one per module format. */
export const GUARD_FILENAMES = ['guard.ts', 'guard.js', 'guard.mjs', 'guard.cjs'] as const;

/**
 * How the runtime that loads a file resolves the specifiers inside it.
 *
 * Not a detail: the three answers differ about extensions, and a specifier that reads fine is a
 * `MODULE_NOT_FOUND` at boot if it names something its own loader will not look for.
 *
 * - `cjs` — `require()` guesses `.js`, `.json`, `.node`. It never guesses `.cjs`.
 * - `esm` — Node's ESM resolver guesses nothing. The extension has to be written out.
 * - `ts` — a compiler or bundler resolves the specifier, and accepts it bare or with the `.js` extension
 *   TypeScript emits for a `.ts` source.
 */
export type ModuleKind = 'ts' | 'cjs' | 'esm';

/** The loader that will read this file, from its extension and the package's `type`. */
export function moduleKindOf(filePath: string, packageIsModule: boolean): ModuleKind {
  if (/\.(?:ts|tsx|mts|cts|jsx)$/.test(filePath)) return 'ts';
  if (/\.mjs$/.test(filePath)) return 'esm';
  if (/\.cjs$/.test(filePath)) return 'cjs';

  return packageIsModule ? 'esm' : 'cjs';
}

export interface GuardModuleQuery {
  /** Absolute path of the file the specifier was written in. */
  fromFile: string;
  /** Absolute path of the directory the guard was scaffolded into. */
  guardDir: string;
  /** How `fromFile` will be loaded. */
  kind: ModuleKind;
  /**
   * Hold the specifier to what its own loader would really resolve.
   *
   * On for the register-based adapters, where the scaffolder writes a specifier matched to the entry's
   * module format, so anything else in the file is a hand-edit that has to be right.
   *
   * Off for the generic scaffold, whose printed plan tells people to import from `<dir>/guard` with no
   * extension whatever their stack is. Under this flag the module IDENTITY is still checked — a sibling in
   * the same directory is not the guard — and only the extension question is left open.
   */
  strictExtensions: boolean;
}

/**
 * Does this specifier name the scaffolded guard module?
 *
 * Two separate questions, and both were answered wrongly at some point. Identity: the resolved path,
 * extension aside, has to BE the guard — `patchstack/rules.json` and `patchstack/guard-helper` both live in
 * the guard's directory and neither is a guard, so containment and substring matching each accepted a
 * module that exports no middleware. Loadability: the file has to exist, and the specifier has to be one
 * this file's own loader will resolve to it.
 */
export function resolvesToGuardModule(specifier: string, query: GuardModuleQuery): boolean {
  const resolved = resolve(dirname(query.fromFile), specifier);
  if (withoutModuleExtension(resolved) !== join(query.guardDir, 'guard')) return false;

  const existing = GUARD_FILENAMES.filter((name) => existsSync(join(query.guardDir, name)));
  if (existing.length === 0) return false;

  const extension = /(\.[A-Za-z0-9]+)$/.exec(specifier)?.[1] ?? '';
  if (!query.strictExtensions) return true;

  if (extension === '') {
    // Bare. Only a loader that guesses can find the file, and each guesses differently.
    if (query.kind === 'esm') return false;
    if (query.kind === 'cjs') return existing.includes('guard.js');

    return true; // a compiler or bundler resolves any of them
  }

  if (existsSync(resolved)) return true;

  // `./guard.js` from a `.ts` source is what TypeScript emits for a `.ts` guard, and resolves.
  return query.kind === 'ts' && extension === '.js' && existing.includes('guard.ts');
}

function withoutModuleExtension(filePath: string): string {
  return filePath.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, '');
}
