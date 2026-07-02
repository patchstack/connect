import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

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
 * a fingerprint is available, exposes it for the widget's parity heartbeat.
 */
export function buildInjectionSnippet(checksum: string | null): string {
  const statements = ['window.__PATCHSTACK_PROD__=true;'];
  if (checksum !== null && checksum !== '') {
    statements.push(`window.__PATCHSTACK_BUILD__=${JSON.stringify(checksum)};`);
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
