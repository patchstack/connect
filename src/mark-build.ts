import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { isEmptyStack, type StackDescriptor } from './stack.js';

/** Attribute that tags our injected <script> so re-runs replace it instead of stacking. */
export const MARKER_ATTR = 'data-patchstack-build';

/** Attribute that distinguishes the widget tag managed by the connector from a manual install. */
export const WIDGET_MARKER_ATTR = 'data-patchstack-connect-widget';

/** Rolling CDN URL for the self-contained disclosure widget. */
export const WIDGET_CDN_URL = 'https://cdn.patchstack.com/patchstack-widget.js';

export type SourceWidgetInjectionStatus =
  | 'inserted'
  | 'updated'
  | 'unchanged'
  | 'existing-manual'
  | 'unsupported';

export interface SourceWidgetInjectionResult {
  html: string;
  status: SourceWidgetInjectionStatus;
}

export type SourceWidgetAnchor = 'body' | 'remix-scripts';

export interface SourceWidgetInjectionOptions {
  /** Structural source anchor. HTML-like shells use body; Remix uses <Scripts />. */
  anchor?: SourceWidgetAnchor;
}

export interface BuildWidgetTagOptions {
  /** Build output opts into the widget's production mode; source preview does not. */
  production?: boolean;
}

export interface InjectMarkerOptions {
  /**
   * Remove a connector-managed widget when the new snippet does not contain one.
   * This is reserved for the explicit `widget: false` path; a missing/invalid
   * config must not erase a valid widget that the compiler already emitted.
   */
  removeManagedWidget?: boolean;
}

export type SourceWidgetIdentityStatus =
  | 'absent'
  | 'configured'
  | 'unconfigured'
  | 'dynamic'
  | 'invalid'
  | 'conflict';

export type SourceWidgetIdentityKind = 'script-tag' | 'initializer' | 'dynamic-loader';

export type SourceWidgetIdentityState =
  | 'configured'
  | 'unconfigured'
  | 'dynamic'
  | 'invalid';

export interface SourceWidgetIdentityOccurrence {
  kind: SourceWidgetIdentityKind;
  state: SourceWidgetIdentityState;
  /** Present only for a statically configured, syntactically valid UUID. */
  uuid?: string;
  /** The rejected literal is included for a useful caller diagnostic. */
  value?: string;
  /** True for a connector-owned CDN tag; all legacy/manual forms are false. */
  managed: boolean;
  /** Loader-only occurrences may be completed by a separate legacy initializer. */
  configuresIdentity: boolean;
  start: number;
  end: number;
}

export interface SourceWidgetIdentityInspection {
  status: SourceWidgetIdentityStatus;
  /** The one unambiguous UUID, or null when absent/unresolved/conflicting. */
  uuid: string | null;
  /** Every distinct valid static UUID, normalized to lowercase. */
  uuids: string[];
  occurrences: SourceWidgetIdentityOccurrence[];
  hasManual: boolean;
  hasManaged: boolean;
}

export type BuildHtmlVerificationIssue =
  | 'not-full-document'
  | 'production-marker-missing'
  | 'production-marker-duplicate'
  | 'production-flag-missing'
  | 'production-marker-order-invalid'
  | 'widget-loader-missing'
  | 'widget-loader-duplicate'
  | 'widget-identity-missing'
  | 'widget-identity-dynamic'
  | 'widget-identity-invalid'
  | 'widget-identity-ambiguous'
  | 'widget-legacy-init-unsafe'
  | 'widget-production-attribute-invalid'
  | 'widget-uuid-mismatch';

/** Strict, non-evaluating verification result for one generated HTML document. */
export interface BuildHtmlVerification {
  ok: boolean;
  issues: BuildHtmlVerificationIssue[];
  isFullDocument: boolean;
  /** Live scripts carrying the connector's build-marker attribute. */
  productionMarkerCount: number;
  /** Marked scripts which contain the production assignment emitted by this package. */
  productionFlagCount: number;
  widgetLoaderCount: number;
  /** The one statically resolved widget identity, or null when unsafe/absent. */
  widgetUuid: string | null;
  expectedSiteUuid: string;
  widgetIdentity: SourceWidgetIdentityInspection;
}

/** Build output directories we look for, in priority order (Vite, CRA, Next export, Nuxt). */
export const BUILD_DIR_CANDIDATES = ['dist', 'build', 'out', '.output/public'];

/**
 * Resolve the directory holding the built HTML. Honours an explicit `--dir`
 * override, otherwise requires exactly one known build directory containing at
 * least one eligible, complete HTML document. Multiple populated candidates are
 * ambiguous: their names and mtimes cannot prove which tree will be deployed,
 * so callers must select one explicitly with `--dir`.
 * Returns null when nothing is found (mark-build then no-ops without failing).
 */
export function resolveBuildDir(cwd: string, override?: string): string | null {
  if (override !== undefined && override !== '') {
    const abs = path.resolve(cwd, override);
    return existsSync(abs) && statSync(abs).isDirectory() ? abs : null;
  }

  const usable: string[] = [];
  for (const candidate of BUILD_DIR_CANDIDATES) {
    const abs = path.resolve(cwd, candidate);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;

    try {
      const containsFullDocument = findHtmlFiles(abs).some((file) => {
        try {
          return hasLiveHtmlDocument(readFileSync(file, 'utf8'));
        } catch {
          return false;
        }
      });
      if (containsFullDocument) usable.push(abs);
    } catch {
      // An unreadable/stale candidate should not hide a later usable output.
    }
  }

  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0]!;
  throw new Error(
    `multiple populated build output directories were found (${usable
      .map((directory) => path.relative(cwd, directory) || directory)
      .join(', ')}); pass --dir <path> for the tree that will actually be deployed`,
  );
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
  siteUuid?: string | null,
  apiBaseUrl?: string | null,
): string {
  const statements = ['window.__PATCHSTACK_PROD__=true;'];
  if (checksum !== null && checksum !== '') {
    statements.push(`window.__PATCHSTACK_BUILD__=${serializeForInlineScript(checksum)};`);
  }
  if (stack != null && !isEmptyStack(stack)) {
    statements.push(`window.__PATCHSTACK_STACK__=${serializeForInlineScript(stack)};`);
  }

  const buildMarker = `<script ${MARKER_ATTR}>${statements.join('')}</script>`;
  if (siteUuid == null || siteUuid === '') {
    return buildMarker;
  }

  // The widget captures document.currentScript while its IIFE executes, so its
  // configuration belongs on the CDN tag itself. `defer` keeps the marker above
  // it in control of production/build metadata before the widget auto-initialises.
  const widget = buildWidgetTag(siteUuid, apiBaseUrl, { production: true });
  return buildMarker + widget;
}

/** Build the one-tag, auto-initialising widget install managed by the connector. */
export function buildWidgetTag(
  siteUuid: string,
  apiBaseUrl?: string | null,
  options: BuildWidgetTagOptions = {},
): string {
  return (
    `<script src="${WIDGET_CDN_URL}"` +
    ` data-site-uuid="${escapeHtmlAttribute(siteUuid)}"` +
    (apiBaseUrl != null && apiBaseUrl !== ''
      ? ` data-api-base="${escapeHtmlAttribute(apiBaseUrl)}"`
      : '') +
    (options.production === true ? ' data-production="true"' : '') +
    ` defer ${WIDGET_MARKER_ATTR}="true"></script>`
  );
}

/** JSON which cannot terminate the surrounding HTML script or introduce JS separators. */
function serializeForInlineScript(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return json.replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      default:
        return '\\u2029';
    }
  });
}

/** True when HTML already loads a manual or connector-managed Patchstack widget bundle. */
export function hasWidgetScript(html: string): boolean {
  return findWidgetScriptIndex(html) !== -1;
}

/**
 * Ensure the managed widget exists in an editable source HTML/JSX shell.
 * Existing connector tags are updated in place; manual/legacy installs win and
 * are never duplicated. Unlike build injection, no production marker is added,
 * so the widget's owner/connect flow remains available in development preview.
 */
export function injectSourceWidget(
  html: string,
  siteUuid: string,
  apiBaseUrl?: string | null,
  options: SourceWidgetInjectionOptions = {},
): SourceWidgetInjectionResult {
  const widgetTag = buildWidgetTag(siteUuid, apiBaseUrl);

  // A user-owned live tag always wins. If an older connector run also left a
  // managed tag beside it, remove only our duplicate and keep the manual tag
  // byte-for-byte rather than updating/reinitialising both.
  if (hasManualSourceWidgetTag(html)) {
    const withoutManagedDuplicate = replaceManagedSourceWidgets(html, '');
    return withoutManagedDuplicate.found
      ? { html: withoutManagedDuplicate.html, status: 'updated' }
      : { html, status: 'existing-manual' };
  }

  const replaced = replaceManagedSourceWidgets(html, widgetTag);
  if (replaced.found) {
    return {
      html: replaced.html,
      status: replaced.html === html ? 'unchanged' : 'updated',
    };
  }

  if (hasManualSourceWidget(html)) {
    return { html, status: 'existing-manual' };
  }

  const injected = insertSourceTag(html, widgetTag, options.anchor ?? 'body');
  return injected === null
    ? { html, status: 'unsupported' }
    : { html: injected, status: 'inserted' };
}

/**
 * True when source contains a live, user-owned widget load or init call.
 * String literals, template-string prompts, comments, and inert HTML blocks do
 * not count. Connector-managed tags are intentionally excluded.
 */
export function hasManualSourceWidget(source: string): boolean {
  return inspectSourceWidgetIdentity(source).hasManual;
}

/**
 * Inspect live widget loaders and their static identity without evaluating source.
 * This intentionally understands only conservative, common forms: a static CDN
 * `src`, `data-site-uuid`, and `PatchstackWidget.init({ userToken/siteUuid })`.
 * Anything executable or otherwise uncertain is surfaced as dynamic rather than
 * guessed, so callers can stop before provisioning a second site accidentally.
 */
export function inspectSourceWidgetIdentity(source: string): SourceWidgetIdentityInspection {
  const tokens = tokenizeSource(source);
  const occurrences: SourceWidgetIdentityOccurrence[] = [];

  for (const tag of findLiveSourceScriptTags(source, tokens)) {
    if (!tag.isWidget) continue;
    const siteUuidIdentity = readSourceScriptAttribute(tag.opening, 'data-site-uuid');
    const identity =
      siteUuidIdentity.kind === 'absent'
        ? readSourceScriptAttribute(tag.opening, 'data-user-token')
        : siteUuidIdentity;
    occurrences.push(
      sourceIdentityOccurrence(
        'script-tag',
        identity,
        tag.isManaged,
        identity.kind !== 'absent',
        tag.start,
        tag.end,
      ),
    );
  }

  for (let i = 0; i < tokens.length; i++) {
    const initOpen = patchstackInitOpenParen(tokens, i);
    if (initOpen !== null) {
      occurrences.push(...inspectInitializerIdentity(tokens, i, initOpen));
      i = initOpen;
      continue;
    }

    // Common dynamic loader: script.src = '.../patchstack-widget.js'.
    if (
      tokens[i]?.kind === 'identifier' &&
      tokenIs(tokens[i + 1], '.') &&
      tokenIs(tokens[i + 2], 'src') &&
      tokenIs(tokens[i + 3], '=') &&
      isWidgetStringToken(tokens[i + 4])
    ) {
      occurrences.push({
        kind: 'dynamic-loader',
        state: 'unconfigured',
        managed: false,
        configuresIdentity: false,
        start: tokens[i]!.start,
        end: tokens[i + 4]!.end,
      });
      continue;
    }

    // Equivalent DOM form: script.setAttribute('src', '...widget.js').
    if (
      tokenIs(tokens[i], '.') &&
      tokenIs(tokens[i + 1], 'setAttribute') &&
      tokenIs(tokens[i + 2], '(') &&
      tokens[i + 3]?.kind === 'string' &&
      tokens[i + 3]?.value.toLowerCase() === 'src' &&
      tokenIs(tokens[i + 4], ',') &&
      isWidgetStringToken(tokens[i + 5])
    ) {
      occurrences.push({
        kind: 'dynamic-loader',
        state: 'unconfigured',
        managed: false,
        configuresIdentity: false,
        start: tokens[i]!.start,
        end: tokens[i + 5]!.end,
      });
    }
  }

  return summarizeSourceWidgetIdentity(occurrences);
}

/**
 * Verify that generated HTML contains one usable production install for the
 * expected site. No code is evaluated: dynamic or ambiguous legacy setups fail
 * closed so a strict CLI mode can report the exact document that needs repair.
 */
export function verifyBuildHtml(
  html: string,
  expectedSiteUuid: string,
): BuildHtmlVerification {
  const issues: BuildHtmlVerificationIssue[] = [];
  const isFullDocument = hasLiveHtmlDocument(html);
  if (!isFullDocument) issues.push('not-full-document');

  const scriptTags = findLiveSourceScriptTags(html);
  const buildMarkers = scriptTags.filter(
    (tag) => readScriptAttribute(tag.opening, MARKER_ATTR) !== undefined,
  );
  const workingBuildMarkers = buildMarkers.filter(
    (tag) =>
      tag.isJavascript &&
      readScriptAttribute(tag.opening, 'src') === undefined &&
      html.slice(tag.contentStart, tag.contentEnd).includes('window.__PATCHSTACK_PROD__=true;'),
  );

  if (buildMarkers.length === 0) issues.push('production-marker-missing');
  else if (buildMarkers.length > 1) issues.push('production-marker-duplicate');
  if (buildMarkers.length === 1 && workingBuildMarkers.length !== 1) {
    issues.push('production-flag-missing');
  }

  const widgetIdentity = inspectSourceWidgetIdentity(html);
  const executableInlineScripts = scriptTags.filter(
    (tag) => tag.isJavascript && readScriptAttribute(tag.opening, 'src') === undefined,
  );
  const occursInExecutableInlineScript = (
    occurrence: SourceWidgetIdentityOccurrence,
  ): boolean =>
    executableInlineScripts.some(
      (tag) => occurrence.start >= tag.contentStart && occurrence.end <= tag.contentEnd,
    );
  const loaders = widgetIdentity.occurrences.filter(
    (occurrence) =>
      occurrence.kind === 'script-tag' ||
      (occurrence.kind === 'dynamic-loader' && occursInExecutableInlineScript(occurrence)),
  );
  const initializers = widgetIdentity.occurrences.filter(
    (occurrence) =>
      occurrence.kind === 'initializer' &&
      occursInExecutableInlineScript(occurrence),
  );

  let widgetUuid: string | null = null;
  if (loaders.length === 0) {
    issues.push('widget-loader-missing');
  } else if (loaders.length > 1) {
    issues.push('widget-loader-duplicate');
  } else {
    const loader = loaders[0]!;
    const loaderTag = scriptTags.find(
      (tag) => tag.start === loader.start && tag.isWidget,
    );
    if (
      loader.managed &&
      readScriptAttribute(loaderTag?.opening ?? '', 'data-production') !== 'true'
    ) {
      issues.push('widget-production-attribute-invalid');
    }
    if (loader.kind === 'dynamic-loader' || loader.state === 'dynamic') {
      issues.push('widget-identity-dynamic');
    } else if (loader.state === 'invalid') {
      issues.push('widget-identity-invalid');
    } else if (loader.state === 'configured') {
      if (initializers.length > 0) issues.push('widget-identity-ambiguous');
      else widgetUuid = loader.uuid ?? null;
    } else if (loader.configuresIdentity) {
      issues.push('widget-identity-missing');
    } else if (initializers.length === 0) {
      issues.push('widget-identity-missing');
    } else if (initializers.length > 1) {
      issues.push('widget-identity-ambiguous');
    } else {
      const initializer = initializers[0]!;
      if (initializer.state === 'dynamic') issues.push('widget-identity-dynamic');
      else if (initializer.state === 'invalid') issues.push('widget-identity-invalid');
      else if (initializer.state !== 'configured') issues.push('widget-identity-missing');
      else {
        const isDeferred =
          loaderTag === undefined ||
          readScriptAttribute(loaderTag.opening, 'async') !== undefined ||
          readScriptAttribute(loaderTag.opening, 'defer') !== undefined ||
          readScriptAttribute(loaderTag.opening, 'type') === 'module';
        if (isDeferred || initializer.start < loader.end) {
          issues.push('widget-legacy-init-unsafe');
        } else {
          widgetUuid = initializer.uuid ?? null;
        }
      }
    }
  }

  const expectedNormalized = expectedSiteUuid.toLowerCase();
  if (widgetUuid !== null && widgetUuid.toLowerCase() !== expectedNormalized) {
    issues.push('widget-uuid-mismatch');
  }

  if (
    workingBuildMarkers.length === 1 &&
    loaders.length === 1 &&
    workingBuildMarkers[0]!.end > loaders[0]!.start
  ) {
    issues.push('production-marker-order-invalid');
  }

  return {
    ok: issues.length === 0,
    issues,
    isFullDocument,
    productionMarkerCount: buildMarkers.length,
    productionFlagCount: workingBuildMarkers.length,
    widgetLoaderCount: loaders.length,
    widgetUuid,
    expectedSiteUuid: expectedNormalized,
    widgetIdentity,
  };
}

function hasManualSourceWidgetTag(source: string, tokens?: SourceToken[]): boolean {
  return findLiveSourceScriptTags(source, tokens).some(
    (tag) => tag.isWidget && !tag.isManaged,
  );
}

/** True when source structurally owns one complete HTML document. */
export function hasLiveHtmlDocument(source: string): boolean {
  const tokens = tokenizeSource(source, { skipRawTextElements: true });
  const htmlOpen = findElementTokenIndices(source, tokens, 'html', false);
  const bodyOpen = findElementTokenIndices(source, tokens, 'body', false);
  const bodyClose = findElementTokenIndices(source, tokens, 'body', true);
  const htmlClose = findElementTokenIndices(source, tokens, 'html', true);
  return (
    htmlOpen.length === 1 &&
    bodyOpen.length === 1 &&
    bodyClose.length === 1 &&
    htmlClose.length === 1 &&
    htmlOpen[0]! < bodyOpen[0]! &&
    bodyOpen[0]! < bodyClose[0]! &&
    bodyClose[0]! < htmlClose[0]!
  );
}

/**
 * Insert (or replace) the marker script in a single HTML document. Idempotent:
 * a prior marker is stripped first so repeated builds don't stack tags. Prefers
 * one live `</head>` and falls back to one live `</body>`. HTML fragments are
 * returned byte-for-byte unchanged instead of being polluted with global tags.
 */
export function injectMarker(
  html: string,
  snippet: string,
  options: InjectMarkerOptions = {},
): string {
  if (!hasLiveHtmlDocument(html) || findBuildInjectionAnchor(html) === null) {
    return html;
  }

  // Remove only connector-managed tags. A manually installed widget is left
  // untouched and suppresses the generated widget below, which makes upgrades
  // from the old manual installation flow safe and prevents double init.
  const withoutOldMarker = stripManagedScript(html, MARKER_ATTR);
  const snippetContainsManagedWidget =
    stripManagedScript(snippet, WIDGET_MARKER_ATTR) !== snippet;
  const removeManagedWidget =
    options.removeManagedWidget ?? snippetContainsManagedWidget;
  const stripped = removeManagedWidget
    ? stripManagedScript(withoutOldMarker, WIDGET_MARKER_ATTR)
    : withoutOldMarker;
  const manualWidgetIndex = findWidgetScriptIndex(stripped);
  if (manualWidgetIndex !== -1) {
    const buildMarkerOnly = stripManagedScript(snippet, WIDGET_MARKER_ATTR);
    // Old versions of the guide installed a synchronous CDN tag manually. Put
    // build globals before that tag so the widget sees production/checksum/stack
    // during its first init, while still preserving the user's installation.
    return (
      stripped.slice(0, manualWidgetIndex) +
      buildMarkerOnly +
      stripped.slice(manualWidgetIndex)
    );
  }

  const anchor = findBuildInjectionAnchor(stripped);
  return anchor === null
    ? html
    : stripped.slice(0, anchor) + snippet + stripped.slice(anchor);
}

function findBuildInjectionAnchor(source: string): number | null {
  const tokens = tokenizeSource(source, { skipRawTextElements: true });
  const headClose = findElementTokenIndices(source, tokens, 'head', true);
  if (headClose.length === 1) return headClose[0]!;
  const bodyClose = findElementTokenIndices(source, tokens, 'body', true);
  return bodyClose.length === 1 ? bodyClose[0]! : null;
}

function stripManagedScript(html: string, attribute: string): string {
  return html.replace(htmlBlockPattern(), (block) => {
    if (isInertHtmlBlock(block)) {
      return block;
    }
    const openingTag = block.match(/^<script\b[^>]*>/i)?.[0];
    return openingTag !== undefined && readScriptAttribute(openingTag, attribute) !== undefined
      ? ''
      : block;
  });
}

function replaceManagedSourceWidgets(
  source: string,
  replacement: string,
): { html: string; found: boolean } {
  const managed = findLiveSourceScriptTags(source).filter((tag) => tag.isManaged);
  if (managed.length === 0) {
    return { html: source, found: false };
  }

  let updated = source;
  for (let i = managed.length - 1; i >= 0; i--) {
    const tag = managed[i]!;
    updated = updated.slice(0, tag.start) + (i === 0 ? replacement : '') + updated.slice(tag.end);
  }
  return { html: updated, found: true };
}

function insertSourceTag(
  source: string,
  widgetTag: string,
  anchor: SourceWidgetAnchor,
): string | null {
  const tokens = tokenizeSource(source);
  let anchors: number[];
  if (anchor === 'remix-scripts') {
    anchors = findRemixScriptsAnchors(source, tokens);
    if (anchors.length > 1) {
      return null;
    }
    // A conventional Remix root owns <body>; retaining this fallback supports
    // roots that omit <Scripts /> while avoiding arbitrary fragment mutation.
    if (anchors.length === 0) {
      anchors = findElementTokenIndices(source, tokens, 'body', true);
    }
  } else {
    anchors = findElementTokenIndices(source, tokens, 'body', true);
  }

  if (anchors.length !== 1) {
    return null;
  }
  return insertAtSourceAnchor(source, anchors[0]!, widgetTag);
}

function insertAtSourceAnchor(source: string, anchorIndex: number, widgetTag: string): string {
  const lineStart = source.lastIndexOf('\n', anchorIndex - 1) + 1;
  const indentation = source.slice(lineStart, anchorIndex);
  if (/^[\t ]*$/.test(indentation)) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    return (
      source.slice(0, lineStart) +
      indentation +
      widgetTag +
      newline +
      source.slice(lineStart)
    );
  }
  return source.slice(0, anchorIndex) + widgetTag + source.slice(anchorIndex);
}

type SourceTokenKind = 'identifier' | 'string' | 'punctuator';

interface SourceToken {
  kind: SourceTokenKind;
  value: string;
  start: number;
  end: number;
}

interface SourceScriptTag {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  opening: string;
  isJavascript: boolean;
  isWidget: boolean;
  isManaged: boolean;
}

type SourceAttributeIdentity =
  | { kind: 'absent' }
  | { kind: 'static'; value: string }
  | { kind: 'boolean' }
  | { kind: 'dynamic' };

interface TokenizeSourceOptions {
  /** Treat script/style bodies as raw text while locating document structure. */
  skipRawTextElements?: boolean;
}

/**
 * Small conservative lexer for HTML-like framework source. It is not a full
 * JS parser; its job is to distinguish live markup/code from examples inside
 * comments and string/template literals while retaining source offsets.
 */
function tokenizeSource(
  source: string,
  options: TokenizeSourceOptions = {},
): SourceToken[] {
  const tokens: SourceToken[] = [];
  let i = 0;

  while (i < source.length) {
    const inertEnd = findInertContainerEnd(source, i, options.skipRawTextElements === true);
    if (inertEnd !== null) {
      i = inertEnd;
      continue;
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 2);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    const char = source[i]!;
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === '`') {
      i = skipQuotedSource(source, i, '`');
      continue;
    }
    if (char === '"' || char === "'") {
      // Do not let ordinary apostrophes in JSX/HTML text hide later markup.
      if (
        char === "'" &&
        isIdentifierPart(source[i - 1]) &&
        isIdentifierPart(source[i + 1])
      ) {
        i++;
        continue;
      }
      const end = skipQuotedSource(source, i, char);
      tokens.push({
        kind: 'string',
        value: decodeSimpleString(source.slice(i + 1, Math.max(i + 1, end - 1))),
        start: i,
        end,
      });
      i = end;
      continue;
    }
    if (char === '/' && isRegexLiteralStart(tokens)) {
      i = skipRegexLiteral(source, i);
      continue;
    }
    if (isIdentifierStart(char)) {
      const start = i++;
      while (i < source.length && isIdentifierPart(source[i])) {
        i++;
      }
      tokens.push({ kind: 'identifier', value: source.slice(start, i), start, end: i });
      continue;
    }

    tokens.push({ kind: 'punctuator', value: char, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

function findInertContainerEnd(
  source: string,
  index: number,
  skipRawTextElements: boolean,
): number | null {
  for (const name of ['template', 'textarea', 'noscript', 'style']) {
    if (!startsWithOpeningElement(source, index, name)) continue;
    const openingEnd = findOpeningTagEnd(source, index);
    if (openingEnd === null) {
      return source.length;
    }
    const close = new RegExp(`<\\/${name}\\s*>`, 'gi');
    close.lastIndex = openingEnd;
    const match = close.exec(source);
    return match === null ? source.length : match.index + match[0].length;
  }

  if (startsWithOpeningElement(source, index, 'script')) {
    const openingEnd = findOpeningTagEnd(source, index);
    if (openingEnd === null) return source.length;
    const opening = source.slice(index, openingEnd).replace(/^<script\b/i, '<script');
    const type = readScriptAttribute(opening, 'type');
    if (skipRawTextElements || (typeof type === 'string' && !isJavaScriptType(type))) {
      const close = /<\/script\s*>/gi;
      close.lastIndex = openingEnd;
      const match = close.exec(source);
      return match === null ? source.length : match.index + match[0].length;
    }
  }
  return null;
}

function startsWithOpeningElement(source: string, index: number, name: string): boolean {
  if (source[index] !== '<') return false;
  if (source.slice(index + 1, index + name.length + 1).toLowerCase() !== name) return false;
  const boundary = source[index + name.length + 1];
  return boundary === undefined || /[\s/>]/.test(boundary);
}

function skipQuotedSource(source: string, start: number, quote: string): number {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++;
      continue;
    }
    if (source[i] === quote) {
      return i + 1;
    }
  }
  return source.length;
}

function skipRegexLiteral(source: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++;
      continue;
    }
    if (source[i] === '[') inClass = true;
    if (source[i] === ']') inClass = false;
    if (source[i] === '/' && !inClass) {
      i++;
      while (i < source.length && /[a-z]/i.test(source[i]!)) i++;
      return i;
    }
    if (source[i] === '\n' || source[i] === '\r') {
      return i;
    }
  }
  return source.length;
}

function isRegexLiteralStart(tokens: SourceToken[]): boolean {
  const previous = tokens[tokens.length - 1];
  if (previous === undefined) return true;
  if (previous.kind === 'identifier' || previous.kind === 'string') return false;
  return /^(?:\(|\[|\{|=|:|,|;|!|\?|&|\|)$/.test(previous.value);
}

function decodeSimpleString(value: string): string {
  return value.replace(/\\([\\'"`])/g, '$1');
}

function isIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z_$]/.test(value);
}

function isIdentifierPart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_$-]/.test(value);
}

function tokenIs(token: SourceToken | undefined, value: string): boolean {
  return token?.value === value;
}

function isWidgetStringToken(token: SourceToken | undefined): boolean {
  return token?.kind === 'string' && isWidgetScriptUrl(token.value);
}

function isWidgetScriptUrl(value: string): boolean {
  return /(?:^|\/)patchstack-widget(?:\.[a-z0-9_-]+)?\.js(?:[?#].*)?$/i.test(value);
}

function sourceIdentityOccurrence(
  kind: SourceWidgetIdentityKind,
  identity: SourceAttributeIdentity,
  managed: boolean,
  configuresIdentity: boolean,
  start: number,
  end: number,
): SourceWidgetIdentityOccurrence {
  if (identity.kind === 'static') {
    if (identity.value === '') {
      return { kind, state: 'unconfigured', value: '', managed, configuresIdentity, start, end };
    }
    if (isUuid(identity.value)) {
      return {
        kind,
        state: 'configured',
        uuid: identity.value.toLowerCase(),
        managed,
        configuresIdentity,
        start,
        end,
      };
    }
    return {
      kind,
      state: 'invalid',
      value: identity.value,
      managed,
      configuresIdentity,
      start,
      end,
    };
  }
  return {
    kind,
    state: identity.kind === 'dynamic' ? 'dynamic' : 'unconfigured',
    managed,
    configuresIdentity,
    start,
    end,
  };
}

function summarizeSourceWidgetIdentity(
  occurrences: SourceWidgetIdentityOccurrence[],
): SourceWidgetIdentityInspection {
  const uuids = [
    ...new Set(
      occurrences.flatMap((occurrence) =>
        occurrence.state === 'configured' && occurrence.uuid !== undefined
          ? [occurrence.uuid.toLowerCase()]
          : [],
      ),
    ),
  ].sort();
  const loaders = occurrences.filter(
    (occurrence) => occurrence.kind === 'script-tag' || occurrence.kind === 'dynamic-loader',
  );
  const configurationProblems = occurrences.filter(
    (occurrence) => occurrence.configuresIdentity && occurrence.state !== 'configured',
  );

  let status: SourceWidgetIdentityStatus;
  if (
    uuids.length > 1 ||
    loaders.length > 1 ||
    (uuids.length === 1 && configurationProblems.length > 0)
  ) {
    status = 'conflict';
  } else if (uuids.length === 1) {
    // One loader without data attributes plus one static legacy initializer is
    // the supported pre-auto-init installation and is not a conflict.
    status = 'configured';
  } else if (occurrences.some((occurrence) => occurrence.state === 'invalid')) {
    status = 'invalid';
  } else if (occurrences.some((occurrence) => occurrence.state === 'dynamic')) {
    status = 'dynamic';
  } else if (occurrences.length > 0) {
    status = 'unconfigured';
  } else {
    status = 'absent';
  }

  return {
    status,
    uuid: status === 'configured' ? uuids[0] ?? null : null,
    uuids,
    occurrences,
    hasManual: occurrences.some((occurrence) => !occurrence.managed),
    hasManaged: occurrences.some((occurrence) => occurrence.managed),
  };
}

function patchstackInitOpenParen(tokens: SourceToken[], index: number): number | null {
  return tokenIs(tokens[index], 'PatchstackWidget') &&
    tokenIs(tokens[index + 1], '.') &&
    tokenIs(tokens[index + 2], 'init') &&
    tokenIs(tokens[index + 3], '(')
    ? index + 3
    : null;
}

function inspectInitializerIdentity(
  tokens: SourceToken[],
  startIndex: number,
  openParenIndex: number,
): SourceWidgetIdentityOccurrence[] {
  const closeParenIndex = findMatchingPunctuator(tokens, openParenIndex, '(', ')');
  const end = tokens[closeParenIndex ?? openParenIndex]?.end ?? tokens[startIndex]!.end;
  const firstArgument = tokens[openParenIndex + 1];
  if (firstArgument === undefined || tokenIs(firstArgument, ')')) {
    return [initializerOccurrence({ kind: 'boolean' }, tokens[startIndex]!.start, end)];
  }
  if (!tokenIs(firstArgument, '{')) {
    return [initializerOccurrence({ kind: 'dynamic' }, tokens[startIndex]!.start, end)];
  }

  const objectOpenIndex = openParenIndex + 1;
  const objectCloseIndex = findMatchingPunctuator(tokens, objectOpenIndex, '{', '}');
  if (objectCloseIndex === null) {
    return [initializerOccurrence({ kind: 'dynamic' }, tokens[startIndex]!.start, end)];
  }

  const found: SourceWidgetIdentityOccurrence[] = [];
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  for (let i = objectOpenIndex + 1; i < objectCloseIndex; i++) {
    const token = tokens[i]!;
    const atTopLevel = braces === 0 && brackets === 0 && parentheses === 0;
    if (
      atTopLevel &&
      (token.kind === 'identifier' || token.kind === 'string') &&
      (token.value === 'userToken' || token.value === 'siteUuid')
    ) {
      const separator = tokens[i + 1];
      const value = tokens[i + 2];
      const identity: SourceAttributeIdentity = !tokenIs(separator, ':') || value === undefined
        ? { kind: 'dynamic' }
        : value.kind === 'string'
          ? { kind: 'static', value: value.value }
          : { kind: 'dynamic' };
      found.push(initializerOccurrence(identity, token.start, value?.end ?? token.end));
    }

    if (tokenIs(token, '{')) braces++;
    else if (tokenIs(token, '}') && braces > 0) braces--;
    else if (tokenIs(token, '[')) brackets++;
    else if (tokenIs(token, ']') && brackets > 0) brackets--;
    else if (tokenIs(token, '(')) parentheses++;
    else if (tokenIs(token, ')') && parentheses > 0) parentheses--;
  }

  return found.length > 0
    ? found
    : [initializerOccurrence({ kind: 'boolean' }, tokens[startIndex]!.start, end)];
}

function initializerOccurrence(
  identity: SourceAttributeIdentity,
  start: number,
  end: number,
): SourceWidgetIdentityOccurrence {
  return sourceIdentityOccurrence('initializer', identity, false, true, start, end);
}

function findMatchingPunctuator(
  tokens: SourceToken[],
  openIndex: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    if (tokenIs(tokens[i], open)) depth++;
    else if (tokenIs(tokens[i], close)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function findLiveSourceScriptTags(
  source: string,
  suppliedTokens?: SourceToken[],
): SourceScriptTag[] {
  const tokens = suppliedTokens ?? tokenizeSource(source);
  const tags: SourceScriptTag[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!tokenIs(tokens[i], '<') || tokens[i + 1]?.kind !== 'identifier') continue;
    if (tokens[i + 1]?.value.toLowerCase() !== 'script') continue;

    const start = tokens[i]!.start;
    const openingEnd = findOpeningTagEnd(source, start);
    if (openingEnd === null) continue;
    const opening = source.slice(start, openingEnd);
    if (!/^<script\b/i.test(opening)) continue;

    const normalized = opening.replace(/^<Script\b/, '<script');
    const src = readScriptAttribute(normalized, 'src');
    const type = readScriptAttribute(normalized, 'type');
    const isJavascript = typeof type !== 'string' || isJavaScriptType(type);
    const selfClosing = /\/\s*>$/.test(opening);
    const closing = selfClosing
      ? null
      : findRawClosingElement(source, openingEnd, 'script');
    const end = closing?.end ?? openingEnd;
    tags.push({
      start,
      end,
      contentStart: openingEnd,
      contentEnd: closing?.start ?? openingEnd,
      opening: normalized,
      isJavascript,
      isWidget: typeof src === 'string' && isJavascript && isWidgetScriptUrl(src),
      isManaged: readScriptAttribute(normalized, WIDGET_MARKER_ATTR) !== undefined,
    });
  }
  return tags;
}

function findRawClosingElement(
  source: string,
  fromIndex: number,
  name: string,
): { start: number; end: number } | null {
  const close = new RegExp(`<\\/${name}\\s*>`, 'gi');
  close.lastIndex = fromIndex;
  const match = close.exec(source);
  return match === null
    ? null
    : { start: match.index, end: match.index + match[0].length };
}

function findOpeningTagEnd(source: string, start: number): number | null {
  let quote: string | null = null;
  let braces = 0;
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i]!;
    if (quote !== null) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      braces++;
      continue;
    }
    if (char === '}' && braces > 0) {
      braces--;
      continue;
    }
    if (char === '>' && braces === 0) {
      return i + 1;
    }
  }
  return null;
}

function findElementTokenIndices(
  source: string,
  tokens: SourceToken[],
  name: string,
  closing: boolean,
): number[] {
  const indices: number[] = [];
  for (let i = 0; i < tokens.length - (closing ? 3 : 1); i++) {
    if (!tokenIs(tokens[i], '<')) continue;
    const nameToken = tokens[i + (closing ? 2 : 1)];
    if (closing && !tokenIs(tokens[i + 1], '/')) continue;
    if (!closing && tokenIs(tokens[i + 1], '/')) continue;
    if (nameToken?.kind !== 'identifier' || nameToken.value.toLowerCase() !== name) continue;
    const tagEnd = findOpeningTagEnd(source, tokens[i]!.start);
    if (tagEnd !== null) indices.push(tokens[i]!.start);
  }
  return indices;
}

function findRemixScriptsAnchors(source: string, tokens: SourceToken[]): number[] {
  const anchors: number[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!tokenIs(tokens[i], '<') || !tokenIs(tokens[i + 1], 'Scripts')) continue;
    const start = tokens[i]!.start;
    const end = findOpeningTagEnd(source, start);
    if (end !== null && /\/\s*>$/.test(source.slice(start, end))) {
      anchors.push(start);
    }
  }
  return anchors;
}

function findWidgetScriptIndex(html: string): number {
  for (const match of html.matchAll(htmlBlockPattern())) {
    const block = match[0];
    if (isInertHtmlBlock(block)) {
      continue;
    }
    const openingTag = block.match(/^<script\b[^>]*>/i)?.[0];
    if (openingTag === undefined) {
      continue;
    }
    const type = readScriptAttribute(openingTag, 'type');
    if (typeof type === 'string' && !isJavaScriptType(type)) {
      continue;
    }
    const src = readScriptAttribute(openingTag, 'src');
    if (
      typeof src === 'string' &&
      /(?:^|\/)patchstack-widget(?:\.[a-z0-9_-]+)?\.js(?:[?#].*)?$/i.test(src)
    ) {
      return match.index ?? -1;
    }
  }
  return -1;
}

function htmlBlockPattern(): RegExp {
  // Match inert containers before script blocks so examples/templates do not
  // suppress a live widget or lose marker-looking content during replacement.
  return /<!--[\s\S]*?-->|<(template|textarea|noscript|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
}

function isInertHtmlBlock(block: string): boolean {
  return block.startsWith('<!--') || /^<(?:template|textarea|noscript|style)\b/i.test(block);
}

function isJavaScriptType(value: string): boolean {
  const mime = value.trim().toLowerCase().split(';', 1)[0];
  return mime === '' || mime === 'module' || /(?:java|ecma)script$/.test(mime ?? '');
}

/** Read a real attribute from a script tag without matching names inside values. */
function readScriptAttribute(tag: string, wantedName: string): string | true | undefined {
  const attribute = readSourceScriptAttribute(tag, wantedName);
  return attribute.kind === 'absent'
    ? undefined
    : attribute.kind === 'static'
      ? attribute.value
      : true;
}

function readSourceScriptAttribute(
  tag: string,
  wantedName: string,
): SourceAttributeIdentity {
  const openingName = tag.match(/^<script\b/i);
  if (openingName === null) return { kind: 'absent' };

  let index = openingName[0].length;
  while (index < tag.length) {
    while (index < tag.length && /[\s/]/.test(tag[index]!)) index++;
    if (index >= tag.length || tag[index] === '>') break;

    const nameStart = index;
    while (index < tag.length && !/[\s=/>]/.test(tag[index]!)) index++;
    const name = tag.slice(nameStart, index);
    while (index < tag.length && /\s/.test(tag[index]!)) index++;

    let identity: SourceAttributeIdentity = { kind: 'boolean' };
    if (tag[index] === '=') {
      index++;
      while (index < tag.length && /\s/.test(tag[index]!)) index++;
      const quote = tag[index];
      if (quote === '"' || quote === "'") {
        const valueStart = ++index;
        while (index < tag.length && tag[index] !== quote) index++;
        identity = { kind: 'static', value: tag.slice(valueStart, index) };
        if (tag[index] === quote) index++;
      } else if (tag[index] === '{') {
        index = skipRawBracedExpression(tag, index);
        identity = { kind: 'dynamic' };
      } else {
        const valueStart = index;
        while (index < tag.length && !/[\s>]/.test(tag[index]!)) index++;
        identity = { kind: 'static', value: tag.slice(valueStart, index) };
      }
    }

    if (name.toLowerCase() === wantedName.toLowerCase()) {
      return identity;
    }
  }
  return { kind: 'absent' };
}

function skipRawBracedExpression(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (quote !== null) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
