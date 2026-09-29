// Managed Patchstack Connector tag — Connect installs it for you.
//
// After a successful scan Connect ensures the site's root HTML shell
// carries the widget's one-liner CDN tag (the canonical install form from the
// widget docs: a single <script> with `data-site-uuid`, auto-initialising on
// DOMContentLoaded). The tag carries an ownership attribute so re-runs update
// it in place instead of stacking copies, and so `uninstall` flows can find it.
// A manual/legacy install (any other reference to the widget script) is always
// left untouched — we never convert or duplicate someone's hand-rolled tag.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeProjectFileSync } from './safe-file.js';
import type { Environment } from './types.js';

export const WIDGET_SCRIPT_URL = 'https://cdn.patchstack.com/patchstack-widget.js';

/** Attribute that tags the Connect-managed widget tag so re-runs update it. */
export const WIDGET_MARKER_ATTR = 'data-patchstack-connect-widget';

/** Substring that marks any widget install (managed or manual) in HTML. */
const WIDGET_NEEDLE = 'patchstack-widget';

/**
 * Root HTML shells Connect is willing to edit, in priority order:
 * Vite/plain SPA, CRA-style, SvelteKit. A framework whose root is code rather
 * than HTML has no entry here; a JSX one is handled by `ensureSourceWidget`'s
 * fallback below, and the rest get the snippet printed by `guide`.
 */
export const SOURCE_SHELL_CANDIDATES = ['index.html', 'public/index.html', 'src/app.html'];

/**
 * The widget's build-mode value for pages published exactly as they sit in the project. The widget shows
 * the owner panels only on a local host (localhost, a private address, `file:`) and treats every other
 * host as the live site. Widget bundles that predate this value read it as the default build mode.
 */
export const LOCAL_BUILD_MODE = 'local';

/**
 * What `ensureWidgetInHtml` does with the managed tag's `data-build-mode`:
 * `'local'` writes it, replacing `"false"`, which gives visitors the same result but also hides the owner
 * panels on a local host; `null` removes `"local"`; `undefined` leaves the attribute exactly as found. Any
 * other value is the project's own choice and is never changed.
 */
export type WidgetBuildMode = typeof LOCAL_BUILD_MODE | null | undefined;

const BUILD_MODE_ATTR_RE = /\sdata-build-mode\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function buildModeOf(tag: string): string | null {
  const match = tag.match(BUILD_MODE_ATTR_RE);

  if (match === null) {
    return null;
  }

  return match[1] ?? match[2] ?? match[3] ?? '';
}

export function buildWidgetTag(siteUuid: string, buildMode: string | null = null): string {
  const mode = buildMode !== null ? ` data-build-mode="${buildMode}"` : '';
  return `<script src="${WIDGET_SCRIPT_URL}" data-site-uuid="${siteUuid}" defer${mode} ${WIDGET_MARKER_ATTR}="true"></script>`;
}

/** The build mode a managed tag should end up with, given what it carries now. */
function resolveBuildMode(current: string | null, wanted: WidgetBuildMode): string | null {
  if (wanted === undefined) {
    return current;
  }

  if (wanted === LOCAL_BUILD_MODE) {
    return current === null || current === 'false' ? LOCAL_BUILD_MODE : current;
  }

  return current === LOCAL_BUILD_MODE ? null : current;
}

/** Set, replace or remove `data-build-mode` on a managed tag, leaving every other attribute as it is. */
function withBuildMode(tag: string, mode: string | null): string {
  if (mode === null) {
    return tag.replace(BUILD_MODE_ATTR_RE, '');
  }

  if (BUILD_MODE_ATTR_RE.test(tag)) {
    return tag.replace(BUILD_MODE_ATTR_RE, ` data-build-mode="${mode}"`);
  }

  return tag.replace(WIDGET_MARKER_ATTR, `data-build-mode="${mode}" ${WIDGET_MARKER_ATTR}`);
}

export type WidgetEnsureAction =
  /** No widget present — the managed tag was inserted before </body>. */
  | 'added'
  /** A managed tag existed with a different UUID or build mode — replaced in place. */
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
export function ensureWidgetInHtml(
  html: string,
  siteUuid: string,
  buildMode: WidgetBuildMode = undefined,
): WidgetEnsureResult {
  const managed = html.match(MANAGED_TAG_RE);
  if (managed !== null) {
    const current = buildModeOf(managed[0]);
    const mode = resolveBuildMode(current, buildMode);
    const sameSite = managed[0].includes(`data-site-uuid="${siteUuid}"`);

    if (sameSite && mode === current) {
      return { html, action: 'unchanged' };
    }

    const replacement = sameSite ? withBuildMode(managed[0], mode) : buildWidgetTag(siteUuid, mode);
    if (replacement === managed[0]) {
      return { html, action: 'unchanged' };
    }

    return { html: html.replace(MANAGED_TAG_RE, () => replacement), action: 'updated' };
  }

  if (html.includes(WIDGET_NEEDLE)) {
    return { html, action: 'manual' };
  }

  const bodyClose = html.match(/([ \t]*)<\/body>/i);
  if (bodyClose === null || bodyClose.index === undefined) {
    return { html, action: 'no-body' };
  }
  const indent = bodyClose[1] ?? '';
  const tag = buildWidgetTag(siteUuid, resolveBuildMode(null, buildMode));
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

/**
 * True when the project's root `index.html` is the page that gets published, with no build step in
 * between: package.json has no `build` script. Those pages never pass through `mark-build`, so nothing
 * else tells the widget which host is the live site.
 */
export function publishesPagesAsIs(cwd: string): boolean {
  if (!existsSync(path.join(cwd, 'index.html'))) {
    return false;
  }

  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    const build = pkg.scripts?.build;

    return typeof build !== 'string' || build.trim().length === 0;
  } catch {
    return false;
  }
}

/**
 * The build mode `scan` asks for on the managed tag. A hosted builder's preview (`sandbox`) is not a local
 * host, so its owners need the widget's default build mode there.
 */
export function sourceWidgetBuildMode(cwd: string, environment: Environment): typeof LOCAL_BUILD_MODE | null {
  if (environment === 'sandbox') {
    return null;
  }

  return publishesPagesAsIs(cwd) ? LOCAL_BUILD_MODE : null;
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
  buildMode: WidgetBuildMode = undefined,
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
  const { html, action } = ensureWidgetInHtml(before, siteUuid, buildMode);
  if (html !== before) {
    writeProjectFileSync(cwd, file, html, { encoding: 'utf8' });
  }
  return { shell, action };
}
