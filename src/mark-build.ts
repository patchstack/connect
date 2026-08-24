import { existsSync, readdirSync, statSync } from 'node:fs';
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
