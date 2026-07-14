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
import { WIDGET_CDN_URL } from './mark-build.js';
import { inspectSourceWidgetPreflight } from './source-widget.js';
import { SSR_CAPABLE_FRAMEWORKS, detectStack } from './stack.js';

export const WIDGET_SCRIPT_URL = WIDGET_CDN_URL;

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
  /** Configuration error that prevents a reliable scan, else null. */
  configError: string | null;
  /** False when the project intentionally opts out with `"widget": false`. */
  widgetEnabled?: boolean;
  prebuildWired: boolean;
  postbuildWired: boolean;
  widgetInstalled: boolean;
  /** False when the widget is present but its configured UUID isn't the site UUID. */
  widgetTokenMatches: boolean | null;
  /** Framework label from the declared dependencies (e.g. "next"), best-effort. */
  framework: string | null;
  /** Existing file the widget snippet belongs in, best-effort. */
  widgetFileHint: string | null;
}

const INSTALL_COMMANDS: Record<PackageManager, string> = {
  npm: 'npm install --save-dev @patchstack/connect',
  pnpm: 'pnpm add -D @patchstack/connect',
  yarn: 'yarn add -D @patchstack/connect',
  bun: 'bun add -d @patchstack/connect',
};

/** Invoke the already-installed binary without falling back to a registry fetch. */
const CONNECTOR_COMMANDS: Record<PackageManager, string> = {
  npm: 'npx --no-install patchstack-connect',
  pnpm: 'pnpm exec patchstack-connect',
  yarn: 'yarn patchstack-connect',
  bun: 'bun run patchstack-connect',
};

/** Lockfile → package manager, same priority order as lockfile detection. */
const PM_BY_LOCKFILE: ReadonlyArray<{ filename: string; pm: PackageManager }> = [
  { filename: 'package-lock.json', pm: 'npm' },
  { filename: 'bun.lock', pm: 'bun' },
  { filename: 'bun.lockb', pm: 'bun' },
  { filename: 'pnpm-lock.yaml', pm: 'pnpm' },
  { filename: 'yarn.lock', pm: 'yarn' },
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
  // packageManager is the project's explicit choice and wins when stale
  // lockfiles from a previous migration are still present.
  const declared = readPackageJson(cwd)?.packageManager;
  if (typeof declared === 'string') {
    const match = /^(npm|pnpm|yarn|bun)@[^\s]+$/i.exec(declared.trim());
    if (match !== null) {
      return match[1]!.toLowerCase() as PackageManager;
    }
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

export function connectorCommand(pm: PackageManager): string {
  return CONNECTOR_COMMANDS[pm];
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
   * that UUID as its managed `data-site-uuid` or legacy `userToken`? null when
   * the widget is absent or no UUID is known yet. A stale/wrong UUID makes the
   * widget silently no-op, so a mismatch is worth surfacing.
   */
  uuidMatches: boolean | null;
}

function widgetConfigMatches(content: string, siteUuid: string): boolean {
  const uuid = siteUuid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const managedAttribute = new RegExp(
    `data-site-uuid\\s*=\\s*(["'])${uuid}\\1`,
    'i',
  );
  const legacyInitialiser = new RegExp(`userToken\\s*:\\s*(["'])${uuid}\\1`);
  return managedAttribute.test(content) || legacyInitialiser.test(content);
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
        if (siteUuid != null && widgetConfigMatches(content, siteUuid)) {
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

function resolveWidgetFileHint(cwd: string, framework: string | null): string | null {
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

type ConnectorAction = 'scan' | 'mark-build';

const CONNECTOR_EXECUTABLE_PATTERN =
  String.raw`(?:patchstack-connect|npx\s+--no-install\s+patchstack-connect|pnpm\s+exec\s+patchstack-connect|yarn\s+patchstack-connect|bun\s+run\s+patchstack-connect)`;
const CONNECTOR_ACTION_PATTERN = new RegExp(
  String.raw`^\s*${CONNECTOR_EXECUTABLE_PATTERN}\s+(scan|mark-build)(?=\s|$)([\s\S]*)$`,
);
const CONNECTOR_PREFIX_PATTERN = new RegExp(
  String.raw`^\s*${CONNECTOR_EXECUTABLE_PATTERN}(?=\s|$)`,
);

/** Split only on top-level `&&`; quoted examples must never look executable. */
function splitAndThenCommands(script: string): string[] {
  const commands: string[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | null = null;
  let parentheses = 0;

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]!;
    if (quote !== null) {
      if (character === '\\' && quote !== "'") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') {
      parentheses += 1;
      continue;
    }
    if (character === ')' && parentheses > 0) {
      parentheses -= 1;
      continue;
    }
    if (parentheses === 0 && character === '&' && script[index + 1] === '&') {
      commands.push(script.slice(start, index).trim());
      start = index + 2;
      index += 1;
    }
  }

  commands.push(script.slice(start).trim());
  return commands;
}

function connectorAction(
  command: string,
  requireStrictMarker = false,
  requireStaticOutput = false,
): ConnectorAction | null {
  const match = CONNECTOR_ACTION_PATTERN.exec(command);
  if (match === null) return null;

  const trailing = match[2] ?? '';
  // A dry run/help command does not perform the lifecycle action. Shell
  // alternatives and pipelines also do not provide fail-closed sequencing.
  if (
    /(?:^|\s)(?:--dry-run|--help|-h|--version)(?=\s|$)/.test(trailing) ||
    /[;&|\n\r]/.test(trailing)
  ) {
    return null;
  }
  const action = match[1] as ConnectorAction;
  if (
    action === 'mark-build' &&
    ((requireStrictMarker && !/(?:^|\s)--strict(?=\s|$)/.test(trailing)) ||
      (requireStaticOutput &&
        !/(?:^|\s)--static-output(?=\s|$)/.test(trailing)))
  ) {
    return null;
  }
  return action;
}

function hasConnectorAction(
  script: string,
  action: ConnectorAction,
  requireStrictMarker = false,
  requireStaticOutput = false,
): boolean {
  const commands = splitAndThenCommands(script);
  return (
    commands.every((command) => command.length > 0) &&
    commands.some(
      (command) =>
        connectorAction(command, requireStrictMarker, requireStaticOutput) === action,
    )
  );
}

function isExistingBuildCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0 || CONNECTOR_PREFIX_PATTERN.test(trimmed)) return false;
  // These are common ways a connector command is mentioned without building.
  return !/^(?:#|echo(?:\s|$)|printf(?:\s|$)|true\s*$|false\s*$|:\s*$)/.test(trimmed);
}

function inspectBuildLifecycle(
  scripts: Record<string, string> | undefined,
  packageManager: PackageManager,
  framework: string | null,
): Pick<GuideState, 'prebuildWired' | 'postbuildWired'> {
  const requireStaticOutput =
    framework !== null && SSR_CAPABLE_FRAMEWORKS.has(framework);
  const buildCommands = splitAndThenCommands(scripts?.build ?? '');
  if (buildCommands.some((command) => command.length === 0)) {
    return { prebuildWired: false, postbuildWired: false };
  }
  const existingBuildIndices = buildCommands.flatMap((command, index) =>
    isExistingBuildCommand(command) ? [index] : [],
  );
  const hasExistingBuild = existingBuildIndices.length > 0;
  const scanBeforeBuild = buildCommands.some(
    (command, index) =>
      connectorAction(command) === 'scan' &&
      existingBuildIndices.some((buildIndex) => buildIndex > index),
  );
  const markerAfterBuild = buildCommands.some(
    (command, index) =>
      connectorAction(command, true, requireStaticOutput) === 'mark-build' &&
      existingBuildIndices.some((buildIndex) => buildIndex < index),
  );
  const lifecycleHooksRun = packageManager !== 'yarn';

  return {
    prebuildWired:
      hasExistingBuild &&
      (scanBeforeBuild ||
        (lifecycleHooksRun && hasConnectorAction(scripts?.prebuild ?? '', 'scan'))),
    postbuildWired:
      hasExistingBuild &&
      (markerAfterBuild ||
        (lifecycleHooksRun &&
          hasConnectorAction(
            scripts?.postbuild ?? '',
            'mark-build',
            true,
            requireStaticOutput,
          ))),
  };
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
  let configError: string | null = null;
  let widgetEnabled = true;
  try {
    const config = await resolveConfig({ cwd });
    siteUuid = config.siteUuid;
    widgetEnabled = config.widgetEnabled !== false;
    if (siteUuid !== null) {
      claimUrl = buildClaimUrl(config.endpoint, siteUuid);
    }
    if (config.endpoint !== DEFAULT_ENDPOINT) {
      endpointOverride = config.endpoint;
    }
  } catch (err) {
    configError = err instanceof Error ? err.message : 'Unknown connector configuration error.';
  }

  // Framework detection needs only the declared top-level dependencies, so we
  // read package.json instead of the (much heavier) lockfile scan.
  const declaredNames = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
  const stack = detectStack(
    declaredNames.map((name) => ({ name, version: '' })),
    {},
  );

  let widgetInstalled = false;
  let widgetTokenMatches: boolean | null = null;
  let inspectedWidgetFileHint: string | null = null;
  try {
    const widget = await inspectSourceWidgetPreflight({
      cwd,
      stack,
      expectedSiteUuid: siteUuid,
    });
    widgetInstalled =
      widget.shells.length > 0 &&
      widget.status !== 'ambiguous' &&
      widget.missingRequiredShells.length === 0 &&
      widget.externalWidgetShells.length === 0 &&
      widget.shells.every((shell) =>
        shell.identity.occurrences.some(
          (occurrence) =>
            occurrence.kind === 'script-tag' || occurrence.kind === 'dynamic-loader',
        ),
      );
    if (widgetInstalled && siteUuid !== null) {
      widgetTokenMatches =
        widget.status === 'configured' && widget.matchesExpectedUuid === true;
    }
    if (widget.files[0] !== undefined) {
      inspectedWidgetFileHint = path.relative(cwd, widget.files[0]);
    }
  } catch {
    // Source inspection is advisory. Preserve the rest of the checklist when
    // a file disappears or becomes unreadable during the probe.
  }
  const lifecycle = inspectBuildLifecycle(pkg?.scripts, packageManager, stack.framework);

  return {
    projectName: pkg?.name ?? null,
    hasPackageJson: pkg !== null,
    packageManager,
    installed,
    siteUuid,
    claimUrl,
    endpointOverride,
    configError,
    widgetEnabled,
    ...lifecycle,
    widgetInstalled,
    widgetTokenMatches,
    framework: stack.framework,
    widgetFileHint:
      inspectedWidgetFileHint ?? resolveWidgetFileHint(cwd, stack.framework),
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
export function countRemainingSteps(state: GuideState): number {
  return [
    state.installed !== null,
    state.siteUuid !== null,
    state.prebuildWired && state.postbuildWired,
    state.widgetEnabled === false ||
      (state.widgetInstalled && state.widgetTokenMatches !== false),
  ].filter((step) => !step).length;
}

export function renderGuideChecklist(state: GuideState, useColor: boolean): string {
  const paint = (code: string, text: string): string =>
    useColor ? `${code}${text}${ANSI.reset}` : text;
  const done = (text: string): string => ` ${paint(ANSI.green, '✔')} ${text}`;
  const todo = (text: string): string => ` ${paint(ANSI.yellow, '✖')} ${paint(ANSI.bold, text)}`;
  const detail = (text: string): string => `     ${paint(ANSI.dim, text)}`;
  const lines: string[] = [];
  const connector = connectorCommand(state.packageManager);
  const requiresStaticOutputAssertion =
    state.framework !== null && SSR_CAPABLE_FRAMEWORKS.has(state.framework);
  const markBuildFlags = requiresStaticOutputAssertion
    ? '--strict --static-output'
    : '--strict';

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
    lines.push(detail('Run the guide from the project root.'));
    return lines.join('\n');
  }

  // 1. Install
  if (state.installed !== null) {
    lines.push(done(`@patchstack/connect installed (${state.installed.version}, ${state.installed.section})`));
  } else {
    lines.push(todo('Install @patchstack/connect as a dev dependency'));
    lines.push(detail(`→ ${installCommand(state.packageManager)}`));
    if (state.packageManager === 'bun') {
      lines.push(detail(`(if bun isn't available here, ${INSTALL_COMMANDS.npm} works too)`));
    }
  }

  // 2. Provision (first scan)
  if (state.configError !== null) {
    lines.push(todo('Fix the invalid connector configuration before scanning'));
    lines.push(detail(state.configError));
    lines.push(detail('Correct .patchstackrc.json or the PATCHSTACK_* override shown above, then rerun the guide.'));
  } else if (state.siteUuid !== null) {
    lines.push(done(`Site provisioned (${state.siteUuid})`));
  } else {
    lines.push(todo('Provision the site — run the first scan'));
    lines.push(detail(`→ ${connector} scan`));
    lines.push(detail('Reads the lockfile, registers the project, writes .patchstackrc.json,'));
    lines.push(
      detail(
        state.widgetEnabled === false
          ? 'keeps the disclosure widget disabled, and prints a claim URL.'
          : 'installs the managed disclosure widget, and prints a claim URL.',
      ),
    );
    lines.push(detail('Reload the app preview after the scan; show the claim URL to the user.'));
  }

  // 3. Build lifecycle
  if (state.prebuildWired && state.postbuildWired) {
    lines.push(
      done(`Build lifecycle wired (scan before builds, mark-build ${markBuildFlags} after)`),
    );
  } else if (state.packageManager === 'yarn') {
    lines.push(
      todo(
        'Wire builds — chain into the package.json build script (modern Yarn skips arbitrary pre/post hooks)',
      ),
    );
    lines.push(detail(`→ "build": "patchstack-connect scan && <existing build command> && patchstack-connect mark-build ${markBuildFlags}"`));
  } else if (state.packageManager === 'bun') {
    lines.push(
      todo('Wire builds — use an explicit build chain for portability across Bun-based hosts'),
    );
    lines.push(detail(`→ "build": "patchstack-connect scan && <existing build command> && patchstack-connect mark-build ${markBuildFlags}"`));
  } else {
    lines.push(todo('Wire builds — add to package.json scripts (chain with && if a hook exists)'));
    if (!state.prebuildWired) {
      lines.push(detail('→ "prebuild": "patchstack-connect scan"'));
    }
    if (!state.postbuildWired) {
      lines.push(detail(`→ "postbuild": "patchstack-connect mark-build ${markBuildFlags}"`));
    }
  }
  if (requiresStaticOutputAssertion) {
    lines.push(
      detail(
        `--static-output is an assertion that every deployed ${state.framework} route is complete static HTML; do not use it for SSR or hybrid deployments.`,
      ),
    );
  }

  // 4. Disclosure widget
  const widgetOk = state.widgetInstalled && state.widgetTokenMatches !== false;
  if (state.widgetEnabled === false) {
    lines.push(done('Disclosure widget intentionally disabled ("widget": false)'));
  } else if (widgetOk) {
    lines.push(done('Disclosure widget installed'));
  } else if (state.widgetInstalled) {
    lines.push(todo("Disclosure widget found, but its configured UUID doesn't match this site's UUID"));
    lines.push(detail(`→ ${connector} scan`));
    lines.push(detail('Move/remove any loader outside the true global shell, repair the reported shell identity, rerun scan, and reload the preview.'));
  } else {
    lines.push(todo('Install the "Report a vulnerability" widget'));
    lines.push(detail(`→ ${connector} scan, then reload the app preview`));
    lines.push(
      detail(
        state.widgetFileHint !== null
          ? `If scan blocks, repair the true global shell or coverage group beginning at ${state.widgetFileHint}, then rerun scan; do not paste a fallback into a nested component.`
          : 'If scan blocks, create/repair the framework global shell(s), move or remove external loaders, and rerun scan; do not paste a fallback into a nested component.',
      ),
    );
  }

  // 5. Claim — the conversion moment; always the loudest line.
  lines.push('');
  if (state.claimUrl !== null) {
    lines.push(` ${paint(ANSI.cyan, '➜')} ${paint(ANSI.bold, 'Claim the site (free, opens the dashboard):')}`);
    lines.push(`   ${paint(ANSI.cyan, state.claimUrl)}`);
    lines.push(detail('Open in a browser. AI agents: show this URL to the user verbatim.'));
    if (state.endpointOverride !== null) {
      lines.push(detail('(this URL inherits the endpoint override above)'));
    }
  } else {
    lines.push(
      detail(`The claim URL appears after the first scan (re-print any time with \`${connector} status\`).`),
    );
  }

  const remaining = countRemainingSteps(state);
  lines.push('');
  if (remaining === 0) {
    lines.push(
      done(
        paint(
          ANSI.bold,
          state.widgetEnabled === false
            ? 'All setup steps complete. Commit .patchstackrc.json and package.json.'
            : 'All setup steps complete. Commit .patchstackrc.json, package.json, and the file carrying the widget tag.',
        ),
      ),
    );
    if (state.claimUrl !== null) {
      lines.push(detail('The only manual action left is claiming the site via the URL above (if not already claimed).'));
    }
  } else {
    lines.push(
      ` ${paint(ANSI.yellow, String(remaining))} step(s) remaining — details in the reference guide below.`,
    );
  }

  return lines.join('\n');
}
