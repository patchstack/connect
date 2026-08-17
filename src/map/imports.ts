import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportedPackage, ImportSite, TsModule } from './types.js';
import { npmPackageOf } from './bindings.js';
import { recognizedSinkKinds } from './sinks.js';

// The app's IMPORT inventory — "which packages does this code pull in", answered for every source file,
// not just the ones that hold an entry point.
//
// Why it is separate from sink collection: a sink is only recorded for the few API families the extractor
// models, and only inside a recognized handler. That makes sinks the wrong instrument for the question a
// vulnerability correlator actually asks — "does this app use package P at all?" — because P may be used
// heavily through an API we have no recognizer for, or from a file with no entry point in it. Answering
// that question from the sink list yields a confident "no", which is the worst possible wrong answer:
// it closes a real vulnerability as unreachable. So imports are collected on their own terms.
//
// Two fidelities, deliberately. Files with an entry-point signal are fully parsed anyway, so their imports
// come from the AST (specifiers AND bound names). The rest — most of a project — are only scanned for
// module specifiers, which is far cheaper than building a syntax tree for every file and is the half that
// matters for correlation. The mixed fidelity is reported per package as `namesComplete` rather than
// smoothed over.

/** A `compilerOptions.paths` entry: `"@/*"` is a prefix, `"foo"` matches only the specifier `foo`. */
export interface PathAlias {
  prefix: string;
  wildcard: boolean;
}

/** One import edge as found in a single file. */
export interface RawImport {
  /** Module specifier exactly as written (`node:fs`, `lodash/merge`, `./db`). */
  specifier: string;
  /** Bound names: real named bindings, plus the markers `default`, `*`, `require`, `import()`. */
  names: string[];
  /** 1-based line of the import. */
  line?: number;
}

/** Cap per package: enough to point a reviewer at the usage, bounded so a big app can't bloat the map. */
const MAX_SITES = 5;

/**
 * A bare specifier that is a legal npm package name. Bare does NOT mean "package": every AI-built app
 * configures a path alias (`@/components` → `./src/components`), and those are the app's OWN code. Letting
 * them into the inventory is not cosmetic — each one lands in the "no recognized sink family" bucket and
 * inflates the count a reviewer reads as unanalysable dependencies.
 */
const NPM_NAME = /^(?:@[^/@\s~][^/@\s]*\/)?[^/@\s.~][^/@\s]*$/;
function isNpmPackageName(pkg: string): boolean {
  return pkg.startsWith('node:') || NPM_NAME.test(pkg);
}

/**
 * Path-alias prefixes declared in `tsconfig.json` / `jsconfig.json` (`compilerOptions.paths`). Best-effort
 * and deliberately shallow: `extends` chains and bundler-config aliases (a `vite.config.ts` `resolve.alias`
 * is code, not data) are not followed, so the name check above remains the backstop. Reads tolerantly —
 * these files routinely carry comments and trailing commas, which `JSON.parse` rejects.
 */
export function readPathAliases(cwd: string): PathAlias[] {
  const aliases: PathAlias[] = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    let paths: Record<string, unknown> | undefined;
    try {
      const raw = readFileSync(join(cwd, name), 'utf8');
      const parsed = JSON.parse(stripJsonComments(raw)) as { compilerOptions?: { paths?: Record<string, unknown> } };
      paths = parsed.compilerOptions?.paths;
    } catch {
      continue; // absent or unparseable: fall back to the name check
    }
    for (const key of Object.keys(paths ?? {})) {
      if (key.startsWith('.')) continue; // a relative alias is already excluded as a non-package
      // The wildcard has to be carried, not flattened into a prefix: an alias `"foo"` covers the
      // specifier `foo` and nothing else, so prefix-matching it would also swallow the real npm
      // package `foobar`. Only `"foo/*"` is a prefix.
      if (key.endsWith('*')) aliases.push({ prefix: key.slice(0, -1), wildcard: true });
      else aliases.push({ prefix: key, wildcard: false });
    }
  }
  return aliases;
}

function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; continue; }
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; quote = c; out += c; continue; }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1'); // trailing commas
}

/**
 * Import edges from a parsed source file: `import`/`export … from`, `require(…)` and dynamic `import(…)`.
 * Relative specifiers are included here and filtered later — the caller decides what counts as a package,
 * and keeping the raw edge makes this function reusable and easy to test.
 */
export function collectFileImports(sf: any, ts: TsModule): RawImport[] {
  const found: RawImport[] = [];
  const lineOf = (node: any): number | undefined => {
    try {
      return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    } catch {
      return undefined;
    }
  };

  const visit = (node: any) => {
    // import x, { a as b }, * as ns from 'mod'   /   import 'mod'
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const names: string[] = [];
      const clause = node.importClause;
      if (clause?.name) names.push('default');
      const nb = clause?.namedBindings;
      if (nb) {
        if (ts.isNamespaceImport(nb)) names.push('*');
        else if (ts.isNamedImports(nb)) {
          // The EXPORTED name is what an advisory names; `import { merge as m }` is still `merge`.
          for (const el of nb.elements) names.push((el.propertyName ?? el.name).text);
        }
      }
      found.push({ specifier: node.moduleSpecifier.text, names, line: lineOf(node) });
    }
    // export { a } from 'mod' — an import edge that re-exports; the package is still pulled in.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const names: string[] = [];
      const ec = node.exportClause;
      if (ec && ts.isNamedExports(ec)) for (const el of ec.elements) names.push((el.propertyName ?? el.name).text);
      else if (ec && ts.isNamespaceExport(ec)) names.push('*');
      else names.push('*'); // export * from 'mod'
      found.push({ specifier: node.moduleSpecifier.text, names, line: lineOf(node) });
    }
    // require('mod') and import('mod') — the call form carries no binding info at the call site, so the
    // marker name records HOW it was imported instead of inventing a binding.
    if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamic) && arg && ts.isStringLiteralLike(arg)) {
        found.push({ specifier: arg.text, names: [isRequire ? 'require' : 'import()'], line: lineOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Module specifiers from raw text, without building a syntax tree — TypeScript's own pre-processor, the
 * same scan the compiler uses to discover a file's dependencies. Token-accurate (a specifier inside a
 * comment or string is not reported), and cheap enough to run over every file in a project.
 * Names are not recoverable this way; callers mark the result as name-incomplete.
 *
 * Returns **null** when the scan itself failed. That is deliberately distinct from an empty array: a file
 * we could not scan is not a file that imports nothing, and collapsing the two is what would let a server
 * conclude "package absent" from a gap in our own analysis.
 */
export function scanFileImports(text: string, ts: TsModule): RawImport[] | null {
  let refs: Array<{ fileName: string; pos: number }>;
  try {
    const pre = ts.preProcessFile(text, /* readImportFiles */ true, /* detectJavaScriptImports */ true);
    refs = pre.importedFiles ?? [];
  } catch {
    return null; // fail-open for the map, but the caller must record that the inventory is now partial
  }
  if (refs.length === 0) return [];
  const lineStarts = lineStartOffsets(text);
  return refs.map((r) => ({ specifier: r.fileName, names: [], line: lineAt(lineStarts, r.pos) }));
}

/**
 * Aggregates per-file import edges into the per-package inventory. Order-independent: the output is
 * sorted, so two runs over the same tree produce byte-identical documents.
 */
export function createImportInventory(aliases: PathAlias[] = []) {
  interface Acc {
    specifiers: Set<string>;
    names: Set<string>;
    namesComplete: boolean;
    sites: ImportSite[];
    siteCount: number;
  }
  const byPackage = new Map<string, Acc>();

  return {
    /** @param parsed whether these edges came from a full parse (names are trustworthy) or the scan. */
    add(relFile: string, edges: RawImport[], parsed: boolean): void {
      for (const edge of edges) {
        const aliased = aliases.some((a) => (a.wildcard ? edge.specifier.startsWith(a.prefix) : edge.specifier === a.prefix));
        if (aliased) continue;
        const pkg = npmPackageOf(edge.specifier);
        if (!pkg) continue; // relative/absolute path: app code, not a dependency
        if (!isNpmPackageName(pkg)) continue; // an unaliased-but-bare path (`@/x`, `~/lib`)
        let acc = byPackage.get(pkg);
        if (!acc) {
          acc = { specifiers: new Set(), names: new Set(), namesComplete: true, sites: [], siteCount: 0 };
          byPackage.set(pkg, acc);
        }
        acc.specifiers.add(edge.specifier);
        for (const n of edge.names) acc.names.add(n);
        // One unparsed site makes the whole package's name set a subset — say so rather than imply
        // completeness from the names that happen to be present.
        if (!parsed) acc.namesComplete = false;
        acc.siteCount++;
        if (acc.sites.length < MAX_SITES) acc.sites.push({ file: relFile, line: edge.line });
      }
    },

    list(): ImportedPackage[] {
      return [...byPackage.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([pkg, acc]) => {
          const names = [...acc.names].sort();
          const entry: ImportedPackage = {
            package: pkg,
            specifiers: [...acc.specifiers].sort(),
            namesComplete: acc.namesComplete,
            sites: acc.sites,
            siteCount: acc.siteCount,
            recognizedSinkKinds: recognizedSinkKinds(pkg),
          };
          if (names.length > 0) entry.names = names;
          return entry;
        });
    },
  };
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 1-based line containing `pos`, by binary search over the line starts. */
function lineAt(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
