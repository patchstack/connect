// Managed disclosure-widget tag — the connector installs the widget for you.
//
// After a successful scan the connector ensures the site's root HTML shell
// carries the widget's one-liner CDN tag (the canonical install form from the
// widget docs: a single <script> with `data-site-uuid`, auto-initialising on
// DOMContentLoaded). The tag carries an ownership attribute so re-runs update
// it in place instead of stacking copies, and so `uninstall` flows can find it.
// A manual/legacy install (any other reference to the widget script) is always
// left untouched — we never convert or duplicate someone's hand-rolled tag.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const WIDGET_SCRIPT_URL = 'https://cdn.patchstack.com/patchstack-widget.js';

/** Attribute that tags the connector-managed widget tag so re-runs update it. */
export const WIDGET_MARKER_ATTR = 'data-patchstack-connect-widget';

/** Substring that marks any widget install (managed or manual) in HTML. */
const WIDGET_NEEDLE = 'patchstack-widget';

/**
 * Root HTML shells the connector is willing to edit, in priority order:
 * Vite/plain SPA, CRA-style, SvelteKit. A framework whose root is code rather
 * than HTML has no entry here; a JSX one is handled by `ensureSourceWidget`'s
 * fallback below, and the rest get the snippet printed by `guide`.
 */
export const SOURCE_SHELL_CANDIDATES = ['index.html', 'public/index.html', 'src/app.html'];

export function buildWidgetTag(siteUuid: string): string {
  return `<script src="${WIDGET_SCRIPT_URL}" data-site-uuid="${siteUuid}" defer ${WIDGET_MARKER_ATTR}="true"></script>`;
}

export type WidgetEnsureAction =
  /** No widget present — the managed tag was inserted before </body>. */
  | 'added'
  /** A managed tag existed with a different UUID — replaced in place. */
  | 'updated'
  /** The managed tag is already present and current. */
  | 'unchanged'
  /** A manual (non-managed) widget install exists — left untouched. */
  | 'manual'
  /** The document has no </body> to anchor on — nothing was changed. */
  | 'no-body';

export interface WidgetEnsureResult {
  html: string;
  action: WidgetEnsureAction;
}

const MANAGED_TAG_RE = new RegExp(
  `<script[^>]*${WIDGET_MARKER_ATTR}[^>]*>\\s*</script>`,
  'i',
);

/**
 * Ensure a single HTML document carries the managed widget tag. Idempotent:
 * updates the managed tag in place, adopts (leaves alone) manual installs, and
 * only ever inserts immediately before </body>.
 */
export function ensureWidgetInHtml(html: string, siteUuid: string): WidgetEnsureResult {
  const tag = buildWidgetTag(siteUuid);

  const managed = html.match(MANAGED_TAG_RE);
  if (managed !== null) {
    if (managed[0].includes(`data-site-uuid="${siteUuid}"`)) {
      return { html, action: 'unchanged' };
    }
    return { html: html.replace(MANAGED_TAG_RE, tag), action: 'updated' };
  }

  if (html.includes(WIDGET_NEEDLE)) {
    return { html, action: 'manual' };
  }

  const bodyClose = html.match(/([ \t]*)<\/body>/i);
  if (bodyClose === null || bodyClose.index === undefined) {
    return { html, action: 'no-body' };
  }
  const indent = bodyClose[1] ?? '';
  const insertion = `${indent}  ${tag}\n${indent}</body>`;
  return {
    html: html.slice(0, bodyClose.index) + insertion + html.slice(bodyClose.index + bodyClose[0].length),
    action: 'added',
  };
}

/** First editable root HTML shell in the project, or null when there is none. */
export function findSourceShell(cwd: string): string | null {
  for (const candidate of SOURCE_SHELL_CANDIDATES) {
    if (existsSync(path.join(cwd, candidate))) {
      return candidate;
    }
  }
  return null;
}

export interface SourceWidgetResult {
  /** Project-relative path of the shell that was inspected, or null. */
  shell: string | null;
  action: WidgetEnsureAction | 'no-shell';
}

/**
 * Ensure the managed widget tag in the project's root shell. Edits at most that one file; returns
 * what happened so the caller can report it.
 *
 * `jsxShell` is the framework's root component, used only when the project has no plain HTML shell —
 * a server-rendered app (TanStack Start, Next, Remix) never produces one, and until this fallback
 * existed those projects were told to paste the tag themselves. That instruction was reliably missed:
 * a hosted builder's agent runs setup, reads "add this yourself", finishes, and the published site
 * carries no widget at all. Nothing downstream can tell that apart from a site that was never set up.
 *
 * The same tag works in both places. JSX reads `<script src="…" defer data-…="true" />` as an
 * element with a boolean `defer`, which is exactly what the HTML form means — and it is already the
 * snippet `guide` prints for these roots, so this inserts what a person following the instructions
 * would have typed.
 *
 * Deliberately NOT behind the production gate the marker uses. The marker claims the site is live;
 * the widget is how an owner claims the site in the first place, and that happens in the preview.
 */
export function ensureSourceWidget(
  cwd: string,
  siteUuid: string,
  jsxShell: string | null = null,
): SourceWidgetResult {
  // A real HTML shell always wins: it is the document the build actually serves, and on a stack that
  // has one the JSX hint would point at a component that merely renders into it.
  const shell = findSourceShell(cwd) ?? jsxShell;
  if (shell === null) {
    return { shell: null, action: 'no-shell' };
  }
  const file = path.join(cwd, shell);
  if (!existsSync(file)) {
    return { shell: null, action: 'no-shell' };
  }
  const before = readFileSync(file, 'utf8');
  const { html, action } = ensureWidgetInHtml(before, siteUuid);
  if (html !== before) {
    writeFileSync(file, html);
  }
  return { shell, action };
}
