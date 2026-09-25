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
  hasJsxShell,
  productionGate,
} from './mark-build.js';
import { detectStack } from './stack.js';
import { buildWidgetTag } from './widget.js';

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
  /** Non-default API endpoint in effect (rc file, env, or flag), else null. */
  endpointOverride: string | null;
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
  astro: ['src/layouts/Layout.astro'],
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
  let endpointOverride: string | null = null;
  let widgetOptOut = false;
  try {
    const config = await resolveConfig({ cwd });
    siteUuid = config.siteUuid;
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
    endpointOverride,
    hasBuildScript: Boolean(pkg?.scripts?.build?.trim()),
    installScanWired: (pkg?.scripts?.postinstall ?? '').includes('patchstack-connect scan'),
    // The scan has to run first: a later prebuild command may upload and stamp the map that the bundle
    // must retain. Bun skips npm-style pre/post scripts, so its build chain follows the same order.
    prebuildWired:
      /^\s*patchstack-connect\s+scan(?:\s*(?:&&|;)|\s*$)/.test(pkg?.scripts?.prebuild ?? '') ||
      /^\s*patchstack-connect\s+scan(?:\s*(?:&&|;)|\s*$)/.test(pkg?.scripts?.build ?? ''),
    postbuildWired:
      (pkg?.scripts?.postbuild ?? '').includes('patchstack-connect mark-build') ||
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

/** Setup steps still missing — 0 means the checklist is fully green. */
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

export function renderGuideChecklist(state: GuideState, useColor: boolean): string {
  const paint = (code: string, text: string): string =>
    useColor ? `${code}${text}${ANSI.reset}` : text;
  const done = (text: string): string => ` ${paint(ANSI.green, '✔')} ${text}`;
  const todo = (text: string): string => ` ${paint(ANSI.yellow, '✖')} ${paint(ANSI.bold, text)}`;
  const detail = (text: string): string => `     ${paint(ANSI.dim, text)}`;
  const lines: string[] = [];

  const headerParts = [state.framework, state.packageManager].filter(
    (part): part is string => part !== null,
  );
  const name = state.projectName ?? path.basename(process.cwd());
  lines.push(paint(ANSI.bold, `Patchstack setup status — ${name} (${headerParts.join(' · ')})`));
  if (state.endpointOverride !== null) {
    lines.push(
      detail(
        `endpoint override in effect: ${state.endpointOverride} (set via .patchstackrc.json, PATCHSTACK_ENDPOINT, or --endpoint)`,
      ),
    );
  }
  lines.push('');

  if (!state.hasPackageJson) {
    lines.push(todo('No package.json found in this directory.'));
    lines.push(detail('For a JS/Node app, run the guide from its package directory; check that package.json is readable and valid.'));
    lines.push(detail('For a standalone HTML/CSS/browser-JavaScript site, use the Patchstack Connector directly.'));
    lines.push(detail('Do not create a Node project, build hooks, or a server just to install the widget.'));
    lines.push(detail('Use the correct site UUID or widget snippet from the Patchstack dashboard; never invent one.'));
    lines.push(detail('See "Plain HTML sites" in AGENT-INSTALL.md. Widget-only setup provides no dependency scan or runtime protection.'));
    return lines.join('\n');
  }

  // The person watching this run usually did not write the project. The install
  // is the longest silence in their first hour with Patchstack, so the guide
  // asks the agent to fill it — a request, never something the setup relies on.
  if (countRemainingSteps(state) > 0) {
    lines.push(` ${paint(ANSI.cyan, '➜')} ${paint(ANSI.bold, 'Tell the user what you are doing as you go.')}`);
    lines.push('   Installs here take minutes and they are watching output they cannot read.');
    lines.push('   Say it in plain words: their site is built out of hundreds of ready-made');
    lines.push('   pieces of code, Patchstack keeps track of which ones it uses and warns them');
    lines.push('   when one turns out to be unsafe, and nothing their visitors see changes.');
    lines.push('   Avoid lockfile / dependency / manifest / npm / UUID when speaking to them.');
    lines.push('');
  }

  // Until the first scan, `setup` covers every step listed below in one bounded command, so the
  // checklist names it first rather than leaving the agent to assemble the steps by hand.
  if (state.siteUuid === null) {
    lines.push(` ${paint(ANSI.cyan, '➜')} ${paint(ANSI.bold, 'Nothing is set up yet — two commands cover the steps below:')}`);
    if (state.installed?.section !== 'dependencies') {
      lines.push(`   ${installCommand(state.packageManager)}`);
    }
    lines.push('   npx @patchstack/connect setup');
    lines.push('   setup provisions the site, adds the widget, installs and verifies runtime protection,');
    lines.push('   and wires the install and build scans, then prints this checklist again. Anything');
    lines.push('   still listed there is a step setup could not apply safely, and is yours to finish.');
    lines.push('');
  }

  // 1. Install
  if (state.installed?.section === 'dependencies') {
    lines.push(done(`@patchstack/connect installed (${state.installed.version}, ${state.installed.section})`));
  } else if (state.installed !== null) {
    lines.push(todo(`Move @patchstack/connect to runtime dependencies (currently ${state.installed.section})`));
    lines.push(detail(`Run → ${installCommand(state.packageManager)}`));
    lines.push(detail('The generated guard imports @patchstack/connect/protect at runtime.'));
  } else {
    lines.push(todo('Install @patchstack/connect as a runtime dependency'));
    lines.push(detail(`Run → ${installCommand(state.packageManager)}`));
    if (state.packageManager === 'bun') {
      lines.push(detail(`(if bun isn't available here, ${INSTALL_COMMANDS.npm} works too)`));
    }
  }

  // 2. Provision (first scan)
  if (state.siteUuid !== null) {
    lines.push(done(`Site provisioned (${state.siteUuid})`));
  } else {
    lines.push(todo('Provision the site — run the first scan'));
    lines.push(detail('Run → npx @patchstack/connect scan'));
    lines.push(detail('Reads the lockfile, registers the project, writes .patchstackrc.json,'));
    lines.push(detail('and prints a dashboard link. The CLI prints the link but never opens it.'));
    lines.push(detail('If your tool refuses to run this command, hand it to the person instead of working'));
    lines.push(detail('around it — see "When your tool will not run this CLI" in the reference guide.'));
  }

  // 3. Dependency-change scan
  if (state.installScanWired) {
    lines.push(done('Dependency-install scan wired (postinstall)'));
  } else {
    lines.push(todo('Scan again whenever dependencies are installed'));
    lines.push(detail('Edit package.json → "postinstall": "patchstack-connect scan"'));
  }

  // 4. Build hooks
  if (!state.hasBuildScript) {
    lines.push(done('No build script to integrate (postinstall covers dependency changes)'));
  } else if (state.prebuildWired && state.postbuildWired) {
    lines.push(done('Build hooks wired (scan before builds, mark-build after)'));
  } else if (state.packageManager === 'bun') {
    // bun run skips npm-style pre/post scripts, so chain inside the build script.
    lines.push(todo('Wire the build hooks yourself — edit package.json (bun skips pre/post hooks, so chain inside "build")'));
    lines.push(detail('Edit package.json → "build": "patchstack-connect scan && <existing build command> && patchstack-connect mark-build"'));
  } else {
    lines.push(todo('Wire the build hooks yourself — edit package.json "scripts" (chain with && if a hook already exists)'));
    if (!state.prebuildWired) {
      lines.push(detail('Edit package.json → "prebuild": "patchstack-connect scan"'));
    }
    if (!state.postbuildWired) {
      lines.push(detail('Edit package.json → "postbuild": "patchstack-connect mark-build"'));
    }
  }

  // 5. Patchstack Connector
  const widgetOk = state.widgetInstalled && state.widgetTokenMatches !== false;
  if (state.widgetOptOut && !widgetOk) {
    lines.push(done('Patchstack Connector disabled by config ("widget": false in .patchstackrc.json)'));
  } else if (widgetOk) {
    lines.push(done('Patchstack Connector installed'));
  } else if (state.widgetInstalled) {
    lines.push(todo("Fix the Patchstack Connector yourself — its site UUID doesn't match this project's"));
    lines.push(detail(`Edit the widget tag → set data-site-uuid (or userToken) to '${state.siteUuid}' (a wrong UUID makes the widget silently no-op)`));
  } else if (state.siteUuid === null) {
    lines.push(todo('Add the Patchstack Connector — the first scan does this for you'));
    lines.push(detail('Run → npx @patchstack/connect scan  (provisions the site and adds the widget tag'));
    lines.push(detail('  to the root HTML shell: index.html / public/index.html / src/app.html)'));
  } else {
    lines.push(todo('Add the Patchstack Connector yourself — this root is code, not a plain HTML shell'));
    lines.push(detail('Note → a normal `scan` adds this tag to a plain HTML shell automatically; add it by hand here:'));
    const placement =
      state.widgetFileHint !== null
        ? `Edit ${state.widgetFileHint} → put it just before </body>:`
        : "Edit your root layout → put it just before </body> (the framework's HTML/layout mechanism, never a JS entry point):";
    lines.push(detail(placement));
    lines.push(detail(`  ${buildWidgetTag(state.siteUuid)}`));
    lines.push(detail('The site UUID is public by design — it ships in client-side HTML.'));
  }

  // 5b. Production marker on server-rendered roots. A code root never emits a
  // static HTML file, so `mark-build` has nothing to stamp and the marker only
  // reaches production if it ships in the shell alongside the widget tag.
  if (needsSourceProductionMarker(state)) {
    if (state.productionMarkerWired) {
      lines.push(done('Production marker wired (widget switches to report mode on the published site)'));
    } else {
      lines.push(todo('Add the production marker — this root is server-rendered, so mark-build cannot stamp it'));
      lines.push(
        detail(
          'Without it the widget treats the published site as build mode and shows the claim flow to visitors.',
        ),
      );
      const gate = productionGate(state.framework);
      if (hasJsxShell(state.framework)) {
        lines.push(detail(`Run → npx @patchstack/connect scan  (adds it to ${state.widgetFileHint} automatically)`));
        lines.push(detail('Or add it by hand, in <head> above the widget tag:'));
        for (const snippetLine of buildSourceMarkerSnippet(state.framework).split('\n')) {
          lines.push(detail(`  ${snippetLine}`));
        }
      } else {
        lines.push(
          detail(
            `Edit ${state.widgetFileHint} → using the framework's head mechanism, emit an inline`,
          ),
        );
        lines.push(detail(`  <script>window.__PATCHSTACK_PROD__=true;</script> only when ${gate}.`));
      }
      lines.push(detail(`The ${gate} guard is required — an ungated marker also hides the claim flow in preview.`))
    }
  }

  // 6. Runtime protection
  if (!state.protectionApplicable) {
    // Not a green tick for a step that was done, and not a red one for a step still owed. A guard screens
    // requests, and a project that only emits files never receives one, so the honest line says the
    // capability does not apply here — and says what does, since "no runtime protection" read alone
    // sounds like a gap rather than a shape.
    lines.push(done('Runtime protection: not applicable — this project has no request path'));
    for (const check of state.protectionChecks.filter((item) => item.hint !== undefined && item.group !== 'reporting')) {
      lines.push(detail(check.hint ?? ''));
    }
  } else if (state.protectionWired) {
    lines.push(done(`Runtime protection wired (${state.protectionStack})`));
  } else {
    lines.push(todo(`Finish runtime protection (${state.protectionStack})`));
    for (const check of state.protectionChecks.filter((item) => !item.ok)) {
      lines.push(detail(`${check.label}${check.hint ? ` — ${check.hint}` : ''}`));
    }
    lines.push(detail('Verify → npx @patchstack/connect protect --check'));
    // Named here rather than run: `guide` is read-only and must never start the application.
    lines.push(detail('Prove a request reaches the guard (starts your app) → npx @patchstack/connect protect --check --runtime'));
  }

  // 7. Attaching the site to an account. Three routes reach the same place, and the widget's own
  // panel leads because it is already on the page the person is looking at. The link and `claim`
  // are for a project with no preview open, or none carrying the widget.
  lines.push('');
  if (state.claimUrl !== null) {
    lines.push(` ${paint(ANSI.cyan, '➜')} ${paint(ANSI.bold, 'Connect this site to your Patchstack account:')}`);
    let route = 1;
    if (widgetTagInPlace(state)) {
      lines.push(`   ${route++}. In the preview — while the site is unclaimed the widget shows a`);
      lines.push('      "Connect this website" panel. Signing in there attaches the site.');
    }
    lines.push(`   ${route++}. In a browser — open the dashboard link (the CLI never opens it):`);
    lines.push(`      ${paint(ANSI.cyan, state.claimUrl)}`);
    lines.push(`   ${route}. From this terminal → npx @patchstack/connect claim`);
    lines.push('      (prints a link to sign in with, then attaches the site to that account)');
    lines.push(detail('Reports have no owner to reach until one of these completes. The site UUID ships'));
    lines.push(detail('in the page and claiming is first-come, so an unclaimed site stays claimable by'));
    lines.push(detail('anyone who loads it.'));
    if (state.endpointOverride !== null) {
      lines.push(detail('(this URL inherits the endpoint override above)'));
    }
  } else {
    lines.push(detail('The dashboard link appears after the first scan (re-print any time with `status`).'));
  }

  // 8. Preview refresh. The tag is in the source, but a page that was already open
  // loaded before it existed and renders nothing until it reloads. Which control appears
  // then depends on claim state: the widget serves the connect panel until the site has an
  // owner, and the report button only after.
  if (widgetTagInPlace(state)) {
    lines.push('');
    lines.push(` ${paint(ANSI.cyan, '➜')} ${paint(ANSI.bold, 'Refresh the preview to see the widget:')}`);
    lines.push('   The widget loads with the page, so a preview that was already open still shows');
    lines.push('   the HTML from before this change. Builders that hot reload refresh it themselves;');
    lines.push('   if nothing appears, refresh the preview once.');
    lines.push('   Unclaimed, the widget shows the "Connect this website" panel; the public');
    lines.push('   "Report a vulnerability" button takes its place once the site is claimed.');
  }

  // 9. Deploy. Everything above is a source change, so the running production site keeps
  // serving its previous build — including one with no widget and no production marker.
  if (state.siteUuid !== null) {
    lines.push('');
    lines.push(` ${paint(ANSI.cyan, '➜')} ${paint(ANSI.bold, 'Deploy to put this on your live site:')}`);
    lines.push('   These are source changes. Your deployed site keeps serving its previous build,');
    lines.push('   so visitors only get the widget after you deploy (or hit Publish) again.');
  }

  const remaining = countRemainingSteps(state);
  lines.push('');
  if (remaining === 0) {
    lines.push(
      done(
        paint(
          ANSI.bold,
          'Ready to deploy. Everything above is in the working tree only: commit .patchstackrc.json, package.json, the runtime guard changes, and the file carrying the widget snippet; add PATCHSTACK_API_KEY to the hosting platform; then deploy. Never commit .patchstackrc.local.json — it holds the API key, and setup has already added it to .gitignore.',
        ),
      ),
    );
    if (state.claimUrl !== null) {
      lines.push(detail('Until the site is attached to an account (dashboard link above, or `claim`), nobody can see its reports.'));
    }
  } else {
    lines.push(
      ` ${paint(ANSI.yellow, String(remaining))} step(s) remaining — details in the reference guide below.`,
    );
  }

  return lines.join('\n');
}
