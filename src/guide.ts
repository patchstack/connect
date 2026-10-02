// `patchstack-connect guide` — a state-aware setup checklist.
//
// Instead of only printing the generic AGENT-INSTALL.md, the guide first inspects
// the current project (package.json, lockfile, .patchstackrc.json, source tree)
// and renders a checklist of what is already done and what is still missing, with
// the exact commands/snippets for THIS project (right package manager, real site
// UUID, framework-specific widget placement). Every probe is best-effort: an
// unreadable project degrades to an all-todo checklist, never a crash.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_ENDPOINT, buildClaimUrl } from './client.js';
import { resolveConfig } from './config.js';
import { runVerify } from './protect/install/index.js';
import type { VerifyCheck } from './protect/install/types.js';
import {
  buildSourceMarkerSnippet,
  hasEditableShell,
  productionGate,
} from './mark-build.js';
import { detectStack } from './stack.js';
import { buildWidgetTag } from './widget.js';
import { type NextStepContext, type Progress } from './progress.js';
import { renderStatus, type MissingItem } from './report.js';
import type { Environment, EnvironmentSource } from './types.js';

/** Global the widget reads to decide it is running on a published build. */
const PROD_MARKER_NEEDLE = '__PATCHSTACK_PROD__';

/** Substring that marks the widget as installed anywhere in the source tree. */
const WIDGET_NEEDLE = 'patchstack-widget';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface GuideState {
  /** package.json `name`, when readable. */
  projectName: string | null;
  hasPackageJson: boolean;
  packageManager: PackageManager;
  /** Version + section when @patchstack/connect is declared, else null. */
  installed: { version: string; section: 'devDependencies' | 'dependencies' } | null;
  siteUuid: string | null;
  claimUrl: string | null;
  /** True when `.patchstackrc.json` records the site as claimed (see `persistClaimState`). */
  claimed: boolean;
  /** Non-default API endpoint in effect (rc file, env, or flag), else null. */
  endpointOverride: string | null;
  /** Where a scan from here reports from, and what decided it. Null when the config is unreadable. */
  environment: Environment | null;
  environmentSource: EnvironmentSource | null;
  hasBuildScript: boolean;
  installScanWired: boolean;
  prebuildWired: boolean;
  postbuildWired: boolean;
  widgetInstalled: boolean;
  /** False when the widget is present but its site UUID isn't this project's. */
  widgetTokenMatches: boolean | null;
  /** True when .patchstackrc.json opts out of widget management ("widget": false). */
  widgetOptOut: boolean;
  /** Framework label from the declared dependencies (e.g. "next"), best-effort. */
  framework: string | null;
  /** Existing file the widget snippet belongs in, best-effort. */
  widgetFileHint: string | null;
  /**
   * True when the root shell already sets `__PATCHSTACK_PROD__`. Only meaningful
   * for code shells: HTML shells get the marker stamped by `mark-build` instead.
   */
  productionMarkerWired: boolean;
  /** Result of the same local inspection used by `protect --check`. */
  protectionWired: boolean;
  protectionStack: string;
  protectionChecks: VerifyCheck[];
  /**
   * Whether a runtime guard is a thing this project can have at all. False for a static build, where
   * `protectionWired: false` is not a step anyone owes — see `VerifyReport.applicable`.
   */
  protectionApplicable: boolean;
}

const INSTALL_COMMANDS: Record<PackageManager, string> = {
  npm: 'npm install --save @patchstack/connect',
  pnpm: 'pnpm add @patchstack/connect',
  yarn: 'yarn add @patchstack/connect',
  bun: 'bun add @patchstack/connect',
};

/**
 * Lockfile → package manager for build-script semantics. Platform-native
 * lockfiles win over package-lock.json because agents often use npm as a
 * fallback inside Bun/pnpm/yarn projects, creating a secondary npm lockfile
 * without changing the platform's actual build runner.
 */
const PM_BY_LOCKFILE: ReadonlyArray<{ filename: string; pm: PackageManager }> = [
  { filename: 'bun.lock', pm: 'bun' },
  { filename: 'bun.lockb', pm: 'bun' },
  { filename: 'pnpm-lock.yaml', pm: 'pnpm' },
  { filename: 'yarn.lock', pm: 'yarn' },
  { filename: 'package-lock.json', pm: 'npm' },
];

/**
 * Framework → candidate layout files the widget snippet belongs in, most
 * specific first. The first candidate that exists in the project wins.
 */
const WIDGET_FILE_CANDIDATES: Record<string, string[]> = {
  next: [
    'app/layout.tsx',
    'app/layout.jsx',
    'src/app/layout.tsx',
    'src/app/layout.jsx',
    'pages/_document.tsx',
    'pages/_document.jsx',
    'src/pages/_document.tsx',
  ],
  nuxt: ['app.vue', 'src/app.vue', 'app/app.vue'],
  remix: ['app/root.tsx', 'app/root.jsx'],
  'react-router': ['app/root.tsx', 'src/root.tsx'],
  'tanstack-start': ['src/routes/__root.tsx', 'app/routes/__root.tsx'],
  sveltekit: ['src/app.html'],
  astro: ['src/layouts/Layout.astro', 'src/layouts/Base.astro', 'src/layouts/BaseLayout.astro'],
  gatsby: ['src/html.js'],
};

/** Fallback candidates for plain Vite / CRA / static projects. */
const GENERIC_WIDGET_FILES = ['index.html', 'public/index.html'];

/** Directories never worth searching for the widget snippet. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.vercel',
  '.netlify',
  'coverage',
  'vendor',
]);

/** Source extensions that can carry the widget <script> tags. */
const WIDGET_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.tsx',
  '.jsx',
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  '.ejs',
  '.hbs',
]);

const WIDGET_SCAN_MAX_FILES = 4000;
const WIDGET_SCAN_MAX_DEPTH = 6;
const WIDGET_SCAN_MAX_BYTES = 512 * 1024;

interface PackageJson {
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export function detectPackageManager(cwd: string): PackageManager {
  const declared = readPackageJson(cwd)?.packageManager?.split('@')[0];
  if (declared === 'npm' || declared === 'pnpm' || declared === 'yarn' || declared === 'bun') {
    return declared;
  }
  for (const { filename, pm } of PM_BY_LOCKFILE) {
    if (existsSync(path.join(cwd, filename))) {
      return pm;
    }
  }
  return 'npm';
}

export function installCommand(pm: PackageManager): string {
  return INSTALL_COMMANDS[pm];
}

function readPackageJson(cwd: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/** Prefer the actually-installed version over the declared range. */
function installedVersion(cwd: string, declaredRange: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(cwd, 'node_modules', '@patchstack', 'connect', 'package.json'), 'utf8'),
    ) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // fall through to the declared range
  }
  return declaredRange;
}

export interface WidgetScanResult {
  found: boolean;
  /**
   * When a site UUID is known: does any file carrying the widget also carry
   * that UUID as its userToken? null when the widget is absent or no UUID is
   * known yet. A stale/wrong userToken makes the widget silently no-op, so a
   * mismatch is worth surfacing rather than passing the check.
   */
  uuidMatches: boolean | null;
}

/**
 * Bounded recursive search for the widget marker in the source tree. Depth,
 * file-count and file-size capped so the guide stays instant on big projects.
 */
export function findWidgetMarker(cwd: string, siteUuid?: string | null): WidgetScanResult {
  let budget = WIDGET_SCAN_MAX_FILES;
  let sawWidget = false;
  let sawTokenMatch = false;

  // Stop early only once the answer can't improve: with no UUID to match, the
  // first hit settles it; with a UUID, keep looking until a matching file shows.
  const settled = (): boolean => sawTokenMatch || (sawWidget && siteUuid == null);

  const walk = (dir: string, depth: number): void => {
    if (depth > WIDGET_SCAN_MAX_DEPTH || budget <= 0) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget <= 0 || settled()) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !WIDGET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      budget -= 1;
      try {
        if (statSync(full).size > WIDGET_SCAN_MAX_BYTES) {
          continue;
        }
        const content = readFileSync(full, 'utf8');
        if (!content.includes(WIDGET_NEEDLE)) {
          continue;
        }
        sawWidget = true;
        if (siteUuid != null && content.includes(siteUuid)) {
          sawTokenMatch = true;
        }
      } catch {
        // unreadable file — skip
      }
    }
  };

  walk(cwd, 0);
  return {
    found: sawWidget,
    uuidMatches: sawWidget && siteUuid != null ? sawTokenMatch : null,
  };
}

/**
 * Whether the root shell already carries the production marker. Reads only the
 * file the snippet belongs in — the marker has one correct home, so a tree walk
 * would cost more and answer no better.
 */
function findProductionMarker(cwd: string, widgetFileHint: string | null): boolean {
  if (widgetFileHint === null) {
    return false;
  }
  try {
    return readFileSync(path.join(cwd, widgetFileHint), 'utf8').includes(PROD_MARKER_NEEDLE);
  } catch {
    return false;
  }
}

export function resolveWidgetFileHint(cwd: string, framework: string | null): string | null {
  const candidates = [
    ...(framework !== null ? WIDGET_FILE_CANDIDATES[framework] ?? [] : []),
    ...GENERIC_WIDGET_FILES,
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(cwd, candidate))) {
      return candidate;
    }
  }
  return framework === 'astro' ? findAstroDocumentLayout(cwd) : null;
}

/**
 * Astro has no fixed name for the layout that renders the page document, so past the common names
 * the shell is the first layout that closes `<body>` itself.
 */
function findAstroDocumentLayout(cwd: string): string | null {
  const dir = path.join('src', 'layouts');
  let names: string[];
  try {
    names = readdirSync(path.join(cwd, dir)).filter((name) => name.endsWith('.astro')).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      if (/<\/body>/i.test(readFileSync(path.join(cwd, dir, name), 'utf8'))) {
        return path.posix.join('src', 'layouts', name);
      }
    } catch {
      // unreadable — try the next layout
    }
  }
  return null;
}

export async function collectGuideState(cwd: string): Promise<GuideState> {
  const pkg = readPackageJson(cwd);
  const packageManager = detectPackageManager(cwd);

  let installed: GuideState['installed'] = null;
  if (pkg?.devDependencies?.['@patchstack/connect'] !== undefined) {
    installed = {
      version: installedVersion(cwd, pkg.devDependencies['@patchstack/connect']),
      section: 'devDependencies',
    };
  } else if (pkg?.dependencies?.['@patchstack/connect'] !== undefined) {
    installed = {
      version: installedVersion(cwd, pkg.dependencies['@patchstack/connect']),
      section: 'dependencies',
    };
  }

  let siteUuid: string | null = null;
  let claimUrl: string | null = null;
  let claimed = false;
  let endpointOverride: string | null = null;
  let widgetOptOut = false;
  let environment: Environment | null = null;
  let environmentSource: EnvironmentSource | null = null;
  try {
    const config = await resolveConfig({ cwd });
    environment = config.environment;
    environmentSource = config.environmentSource ?? null;
    siteUuid = config.siteUuid;
    claimed = siteUuid !== null && config.claimed === true;
    if (siteUuid !== null && config.endpointTrusted !== false) {
      claimUrl = buildClaimUrl(config.endpoint, siteUuid);
    }
    if (config.endpoint !== DEFAULT_ENDPOINT) {
      endpointOverride = config.endpoint;
    }
    widgetOptOut = !config.widget;
  } catch {
    // invalid config — the checklist just shows the site as not provisioned
  }

  // Framework detection needs only the declared top-level dependencies, so we
  // read package.json instead of the (much heavier) lockfile scan.
  const declaredNames = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
  const stack = detectStack(
    declaredNames.map((name) => ({ name, version: '' })),
    {},
  );

  const widget = findWidgetMarker(cwd, siteUuid);
  const widgetFileHint = resolveWidgetFileHint(cwd, stack.framework);
  const protection = runVerify(cwd);

  return {
    projectName: pkg?.name ?? null,
    hasPackageJson: pkg !== null,
    packageManager,
    installed,
    siteUuid,
    claimUrl,
    claimed,
    endpointOverride,
    environment,
    environmentSource,
    hasBuildScript: Boolean(pkg?.scripts?.build?.trim()),
    installScanWired: (pkg?.scripts?.postinstall ?? '').includes('patchstack-connect scan'),
    // The scan has to run first: a later prebuild command may upload and stamp the map that the bundle
    // must retain. Non-npm managers use explicit chains independent of lifecycle settings.
    prebuildWired:
      (packageManager === 'npm' && /^\s*patchstack-connect\s+scan(?:\s*(?:&&|;)|\s*$)/.test(pkg?.scripts?.prebuild ?? '')) ||
      /^\s*patchstack-connect\s+scan(?:\s*(?:&&|;)|\s*$)/.test(pkg?.scripts?.build ?? ''),
    postbuildWired:
      (packageManager === 'npm' && (pkg?.scripts?.postbuild ?? '').includes('patchstack-connect mark-build')) ||
      (pkg?.scripts?.build ?? '').includes('patchstack-connect mark-build'),
    widgetInstalled: widget.found,
    widgetTokenMatches: widget.uuidMatches,
    widgetOptOut,
    framework: stack.framework,
    widgetFileHint: widgetFileHint,
    productionMarkerWired: findProductionMarker(cwd, widgetFileHint),
    protectionWired: protection.wired,
    protectionStack: protection.stack,
    protectionChecks: protection.checks,
    protectionApplicable: protection.applicable,
  };
}

const ANSI = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  cyan: '\u001B[36m',
};

/**
 * True when the site's root shell is code rather than an HTML file. Those roots
 * are server-rendered, so no built HTML file carries the marker to production and
 * `mark-build`'s HTML pass has nothing to stamp.
 */
export function needsSourceProductionMarker(state: GuideState): boolean {
  if (state.siteUuid === null || state.widgetOptOut || state.widgetFileHint === null) {
    return false;
  }
  return !state.widgetFileHint.toLowerCase().endsWith('.html');
}

/**
 * True when the widget tag is in the source with the right site UUID, so the next
 * page load renders it. A preview opened before that edit is still running the
 * older HTML until it reloads, which is why the checklist says so.
 */
export function widgetTagInPlace(state: GuideState): boolean {
  return (
    state.siteUuid !== null &&
    !state.widgetOptOut &&
    state.widgetInstalled &&
    state.widgetTokenMatches !== false
  );
}

/** Technical setup steps still missing; 0 means nothing is owed in the working tree. */
export function countRemainingSteps(state: GuideState): number {
  return [
    state.installed?.section === 'dependencies',
    state.siteUuid !== null,
    state.installScanWired,
    !state.hasBuildScript || (state.prebuildWired && state.postbuildWired),
    state.widgetOptOut || (state.widgetInstalled && state.widgetTokenMatches !== false),
    !needsSourceProductionMarker(state) || state.productionMarkerWired,
    !state.protectionApplicable || state.protectionWired,
  ].filter((step) => !step).length;
}

/** The four progress steps as far as the working tree can tell. */
export function guideProgress(state: GuideState, known: Partial<Progress> = {}): Progress {
  return {
    installed: state.installed !== null,
    // Claim state lives on the server. The working tree has only the note a scan, status or claim left
    // in `.patchstackrc.json`; a caller that has just heard from the server overrides it.
    connected: state.claimed,
    // `.patchstackrc.json` only gains a site UUID from a manifest the server stored.
    synced: state.siteUuid !== null,
    // Only the dashboard can see the live site, so nothing the CLI runs marks this done.
    deployed: false,
    ...known,
  };
}

export function guideNextStepContext(state: GuideState): NextStepContext {
  return {
    installCommand: installCommand(state.packageManager),
    siteUuid: state.siteUuid,
    claimUrl: state.claimUrl,
    environment: state.environment,
    environmentSource: state.environmentSource,
  };
}

/**
 * An unconnected project can be connected by whoever loads it first, so the warning goes wherever the
 * project is shown as not connected. `why` leads when a claim token was tried and did not connect it.
 */
export function notConnectedItem(why: string[] = []): MissingItem {
  return {
    text: 'Not connected to your Patchstack account',
    hint: [...why, 'Until it is, anyone who opens your app can connect it to their own account.'],
  };
}

/** The build-script lines `setup` adds, for someone adding them by hand. */
function buildScriptLines(state: GuideState): string[] {
  const lines: string[] = [];
  if (!state.installScanWired) lines.push('"postinstall": "patchstack-connect scan"');
  if (state.hasBuildScript && !(state.prebuildWired && state.postbuildWired)) {
    if (state.packageManager !== 'npm') {
      lines.push('"build": "patchstack-connect scan && patchstack-connect map --upload && <existing build command> && patchstack-connect mark-build"');
    } else {
      if (!state.prebuildWired) lines.push('"prebuild": "patchstack-connect scan && patchstack-connect map --upload"');
      if (!state.postbuildWired) lines.push('"postbuild": "patchstack-connect mark-build"');
    }
  }
  return lines;
}

/**
 * What the working tree is still missing, each with the one thing to do about it. Until the site exists
 * only a dev-only install is listed: before that, `setup` is the next step and applies the rest.
 *
 * `connected` is whether the caller heard from Patchstack that the project has an owner. Without that
 * answer, the note in `.patchstackrc.json` decides.
 */
export function guideMissing(state: GuideState, known: Partial<Progress> = {}): MissingItem[] {
  const missing: MissingItem[] = [];

  if (state.installed?.section === 'devDependencies') {
    missing.push({
      text: 'Patchstack is installed as a development tool only, so your live app cannot load it',
      hint: [`Run: ${installCommand(state.packageManager)}`],
    });
  }
  if (state.siteUuid === null) return missing;

  if (!state.widgetOptOut && state.widgetInstalled && state.widgetTokenMatches === false) {
    missing.push({
      text: 'The Patchstack widget on your page belongs to a different project',
      hint: [`Set data-site-uuid to '${state.siteUuid}' on the widget tag.`],
    });
  } else if (!state.widgetOptOut && !state.widgetInstalled) {
    missing.push({
      text: 'The Patchstack widget is not on your page yet',
      hint: [
        state.widgetFileHint !== null
          ? `Add this to ${state.widgetFileHint}, just before </body>:`
          : 'Add this to your main page layout, just before </body>:',
        `  ${buildWidgetTag(state.siteUuid)}`,
      ],
    });
  }

  if (state.protectionApplicable && !state.protectionWired) {
    const failing = state.protectionChecks.filter((item) => !item.ok && item.group !== 'reporting');
    const generic = state.protectionStack === 'generic';
    missing.push({
      key: 'runtime-protection',
      text: generic
        ? 'Runtime protection: not added to your server yet'
        : `Runtime protection: not finished for ${state.protectionStack}`,
      hint: generic
        ? ['Add Patchstack where requests enter your app. Run npx @patchstack/connect protect for the steps.']
        : ['Run: npx @patchstack/connect protect, then npx @patchstack/connect protect --check'],
      detail: failing.map((check) => `${check.label}${check.hint ? ` — ${check.hint}` : ''}`),
    });
  }

  const scripts = buildScriptLines(state);
  if (scripts.length > 0) {
    missing.push({
      text: 'Patchstack does not check your packages on install and build yet',
      hint: ['Run: npx @patchstack/connect setup (it adds the build steps to package.json)'],
      detail: [
        state.packageManager === 'bun' ? 'Add to package.json scripts:' : 'Add to package.json scripts (chain with && if one exists):',
        ...scripts.map((line) => `  ${line}`),
      ],
    });
  }

  // A server-rendered root has no built HTML page for `mark-build` to flag as the live site.
  if (needsSourceProductionMarker(state) && !state.productionMarkerWired) {
    const gate = productionGate(state.framework);
    missing.push(
      hasEditableShell(state.framework)
        ? {
            text: 'Your live app does not tell Patchstack it is live yet',
            hint: [`Run: npx @patchstack/connect scan (it edits ${state.widgetFileHint})`],
            detail: [`Or add inside <head>:`, ...buildSourceMarkerSnippet(state.framework).split('\n').map((line) => `  ${line}`)],
          }
        : {
            text: 'Your live app does not tell Patchstack it is live yet',
            hint: [
              `Add this inside <head> in ${state.widgetFileHint}, only when ${gate}:`,
              '  <script>window.__PATCHSTACK_PROD__=true;</script>',
            ],
          },
    );
  }

  if ((known.connected ?? state.claimed) !== true) missing.push(notConnectedItem());

  return missing;
}

export interface RenderGuideOptions {
  verbose?: boolean;
}

export function renderGuideChecklist(
  state: GuideState,
  useColor: boolean,
  known: Partial<Progress> = {},
  options: RenderGuideOptions = {},
): string {
  const paint = (code: string, text: string): string =>
    useColor ? `${code}${text}${ANSI.reset}` : text;
  const name = state.projectName ?? path.basename(process.cwd());
  const title = `Patchstack status for ${name}`;

  if (!state.hasPackageJson) {
    return [
      paint(ANSI.bold, title),
      '',
      paint(ANSI.bold, 'Missing'),
      ` ${paint(ANSI.yellow, '✘')} No package.json here.`,
      '   For a JS/Node app, run this from its package directory.',
      '   For a plain HTML site, follow "Plain HTML sites" in AGENT-INSTALL.md. It gets the widget only: no dependency scan or runtime protection.',
      '   Do not create a Node project just to add the widget.',
      '   Use the site UUID or widget snippet from the Patchstack dashboard. Never invent one.',
    ].join('\n');
  }

  const lines = renderStatus(
    title,
    { done: [], missing: guideMissing(state, known) },
    guideProgress(state, known),
    guideNextStepContext(state),
    { useColor, verbose: options.verbose },
  );

  if (options.verbose === true) {
    const verbose = [
      `Project: ${[state.framework, state.packageManager].filter((part) => part !== null).join(' · ')}`,
      ...(state.siteUuid !== null ? [`Site UUID: ${state.siteUuid}`] : []),
      ...(state.environment !== null ? [`Environment: ${state.environment}${state.environmentSource !== null ? ` (${state.environmentSource})` : ''}`] : []),
      ...(state.endpointOverride !== null ? [`Endpoint override: ${state.endpointOverride}`] : []),
      ...(state.widgetOptOut ? ['Widget is off ("widget": false in .patchstackrc.json).'] : []),
    ];
    lines.splice(1, 0, ...verbose.map((line) => paint(ANSI.dim, line)));
  }

  return lines.join('\n');
}
