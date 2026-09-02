import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isEmptyStack, type StackDescriptor } from './stack.js';

/** Attribute that tags our injected <script> so re-runs replace it instead of stacking. */
export const MARKER_ATTR = 'data-patchstack-build';

/** Build output directories we look for, in priority order (Vite, CRA, Next export, Nuxt). */
export const BUILD_DIR_CANDIDATES = ['dist', 'build', 'out', '.output/public'];

/**
 * Resolve the directory holding the built HTML. Honours an explicit `--dir`
 * override, otherwise picks the first known build directory that exists.
 * Returns null when nothing is found (mark-build then no-ops without failing).
 */
export function resolveBuildDir(cwd: string, override?: string): string | null {
  if (override !== undefined && override !== '') {
    const abs = path.resolve(cwd, override);
    return existsSync(abs) && statSync(abs).isDirectory() ? abs : null;
  }

  for (const candidate of BUILD_DIR_CANDIDATES) {
    const abs = path.resolve(cwd, candidate);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      return abs;
    }
  }

  return null;
}

/** Recursively collect every `.html` file under `dir`. */
export function findHtmlFiles(dir: string): string[] {
  const out: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        out.push(full);
      }
    }
  };

  walk(dir);
  return out;
}

/**
 * The <script> we inject into built HTML. Always marks the build as production
 * (so the widget hides the connect/claim prompt on the published site) and, when
 * available, exposes the build fingerprint (for the parity heartbeat) and the
 * detected stack descriptor (so the widget can report how the site was built).
 */
export function buildInjectionSnippet(
  checksum: string | null,
  stack?: StackDescriptor | null,
): string {
  const statements = ['window.__PATCHSTACK_PROD__=true;'];
  if (checksum !== null && checksum !== '') {
    statements.push(`window.__PATCHSTACK_BUILD__=${JSON.stringify(checksum)};`);
  }
  if (stack != null && !isEmptyStack(stack)) {
    statements.push(`window.__PATCHSTACK_STACK__=${JSON.stringify(stack)};`);
  }
  return `<script ${MARKER_ATTR}>${statements.join('')}</script>`;
}

/**
 * Insert (or replace) the marker script in a single HTML document. Idempotent:
 * a prior marker is stripped first so repeated builds don't stack tags. Prefers
 * `</head>`, falls back to `</body>`, then appends.
 */
export function injectMarker(html: string, snippet: string): string {
  const stripped = html.replace(
    new RegExp(`\\s*<script ${MARKER_ATTR}[^>]*>[\\s\\S]*?</script>`, 'gi'),
    '',
  );

  if (/<\/head>/i.test(stripped)) {
    return stripped.replace(/<\/head>/i, `${snippet}</head>`);
  }
  if (/<\/body>/i.test(stripped)) {
    return stripped.replace(/<\/body>/i, `${snippet}</body>`);
  }
  return stripped + snippet;
}

/* ------------------------------------------------------------------ */
/*  Source-shell marking (server-rendered roots)                      */
/* ------------------------------------------------------------------ */

/**
 * Frameworks whose root shell is JSX. These get a literal snippet; every other
 * code shell gets the requirement described instead, because its head mechanism
 * (`useHead`, `<svelte:head>`, Astro frontmatter) is not a plain script tag and
 * a wrong snippet costs more than an accurate sentence.
 */
const JSX_SHELL_FRAMEWORKS = new Set([
  'next',
  'remix',
  'react-router',
  'tanstack-start',
  'gatsby',
]);

/**
 * How each framework spells "this is a production build" in source. Vite-built
 * roots use `import.meta.env.PROD`, which the bundler statically replaces;
 * bundlers that don't define it fall back to NODE_ENV.
 *
 * The gate is load-bearing: an ungated marker also fires in the hosted builder's
 * dev preview, which is exactly where the owner still needs the claim flow.
 */
const PRODUCTION_GATES: Record<string, string> = {
  next: "process.env.NODE_ENV === 'production'",
  gatsby: "process.env.NODE_ENV === 'production'",
  nuxt: '!import.meta.dev',
};

const DEFAULT_PRODUCTION_GATE = 'import.meta.env.PROD';

/** The build-time expression that must guard the marker for this framework. */
export function productionGate(framework: string | null): string {
  const mapped = framework !== null ? PRODUCTION_GATES[framework] : undefined;
  return mapped ?? DEFAULT_PRODUCTION_GATE;
}

/** True when `guide` can print a literal marker snippet for this framework. */
export function hasJsxShell(framework: string | null): boolean {
  return framework !== null && JSX_SHELL_FRAMEWORKS.has(framework);
}

/**
 * The production marker as it belongs in a JSX root shell.
 *
 * Server-rendered roots never produce a static HTML file for `mark-build` to
 * stamp, so on those stacks this is the only path the marker has to production.
 * It stays an inline document script rather than a module-level assignment: the
 * widget tag is `defer`, and only a parser-executed inline script is ordered
 * ahead of it for certain.
 */
export function buildSourceMarkerSnippet(framework: string | null): string {
  const gate = productionGate(framework);
  return (
    `{${gate} && (\n` +
    `  <script\n` +
    `    ${MARKER_ATTR}="true"\n` +
    `    dangerouslySetInnerHTML={{ __html: 'window.__PATCHSTACK_PROD__=true;' }}\n` +
    `  />\n` +
    `)}`
  );
}

/** Global the widget reads to decide it is running on a published build. */
const PROD_MARKER_GLOBAL = '__PATCHSTACK_PROD__';

/**
 * JSX comment fence around the injected marker. Mirrors the `#region` fence the
 * protect installer uses on server entries: it makes the block obviously ours,
 * and lets a re-run replace it instead of stacking copies.
 */
const REGION_OPEN = '{/* #region patchstack (managed by patchstack-connect — do not edit) */}';
const REGION_CLOSE = '{/* #endregion patchstack */}';
const REGION_RE = /[ \t]*\{\/\* #region patchstack[\s\S]*?#endregion patchstack \*\/\}\n?/g;

export type SourceMarkerAction =
  /** The managed block was inserted (or refreshed in place). */
  | 'added'
  /** A marker is already present and not ours — adopted, left untouched. */
  | 'manual'
  /** No JSX anchor to attach to; the caller falls back to printing the snippet. */
  | 'no-anchor'
  /** This framework's root shell is not JSX, so there is no snippet to insert. */
  | 'unsupported';

export interface SourceMarkerResult {
  source: string;
  action: SourceMarkerAction;
}

interface JsxShellAnchor {
  end: number;
  indent: string;
}

/**
 * Find a literal JSX opening tag at the start of a line. JSX attributes may
 * contain `>` inside strings or braced expressions, so the tag boundary needs
 * a small lexical scan rather than a character class. Self-closing tags cannot
 * carry the marker as a child and are skipped.
 */
function findJsxShellAnchor(source: string, tagName: 'head' | 'body'): JsxShellAnchor | null {
  const candidates = new RegExp(`^([ \\t]*)<${tagName}(?=[\\s/>])`, 'gm');
  let candidate: RegExpExecArray | null;

  while ((candidate = candidates.exec(source)) !== null) {
    let quote: "'" | '"' | '`' | null = null;
    let escaped = false;
    let braces = 0;
    let blockComment = false;
    let lineComment = false;

    for (let index = candidates.lastIndex; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];

      if (lineComment) {
        if (char === '\n') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (char === '*' && next === '/') {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === "'" || char === '"' || char === '`') {
        quote = char;
      } else if (braces > 0 && char === '/' && next === '*') {
        blockComment = true;
        index += 1;
      } else if (braces > 0 && char === '/' && next === '/') {
        lineComment = true;
        index += 1;
      } else if (char === '{') {
        braces += 1;
      } else if (char === '}') {
        if (braces === 0) break;
        braces -= 1;
      } else if (char === '>' && braces === 0) {
        const openingTag = source.slice(candidate.index, index + 1);
        if (/\/\s*>$/.test(openingTag)) break;
        return { end: index + 1, indent: candidate[1] ?? '' };
      }
    }
  }

  return null;
}

/**
 * Insert the production marker into a JSX root shell, idempotently.
 *
 * Anchors as the first child of `<head>`, then `<body>`, so the marker runs
 * before the deferred widget without relying on how that widget is expressed
 * in source. A marker the developer placed themselves is adopted rather than
 * duplicated.
 */
export function ensureMarkerInJsxShell(source: string, framework: string | null): SourceMarkerResult {
  if (!hasJsxShell(framework)) {
    return { source, action: 'unsupported' };
  }

  const stripped = source.replace(REGION_RE, '');
  if (stripped.includes(PROD_MARKER_GLOBAL)) {
    return { source: stripped, action: 'manual' };
  }

  const block = (indent: string): string =>
    [REGION_OPEN, ...buildSourceMarkerSnippet(framework).split('\n'), REGION_CLOSE]
      .map((line) => `${indent}${line}`)
      .join('\n');

  for (const tagName of ['head', 'body'] as const) {
    const anchor = findJsxShellAnchor(stripped, tagName);
    if (anchor === null) continue;

    const indent = `${anchor.indent}  `;
    const remainder = stripped.slice(anchor.end);
    const separator = remainder.startsWith('\n') || remainder.startsWith('\r') ? '' : '\n';
    return {
      source: `${stripped.slice(0, anchor.end)}\n${block(indent)}${separator}${remainder}`,
      action: 'added',
    };
  }

  return { source: stripped, action: 'no-anchor' };
}

export interface EnsureSourceMarkerResult extends SourceMarkerResult {
  /** Project-relative shell that was inspected, or null when there is none. */
  shell: string | null;
}

/**
 * Ensure the production marker in the project's JSX root shell. Runs during
 * `scan`, which is a pre-build hook, so the edit is picked up by the build that
 * follows — the marker reaches production without anyone pasting anything.
 */
export function ensureSourceMarker(
  cwd: string,
  shell: string | null,
  framework: string | null,
): EnsureSourceMarkerResult {
  if (shell === null) {
    return { shell: null, source: '', action: 'no-anchor' };
  }
  const file = path.resolve(cwd, shell);
  const before = readFileSync(file, 'utf8');
  const result = ensureMarkerInJsxShell(before, framework);
  if (result.source !== before) {
    writeFileSync(file, result.source);
  }
  return { ...result, shell };
}
