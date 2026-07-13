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
import { detectStack } from './stack.js';

export const WIDGET_SCRIPT_URL = 'https://cdn.patchstack.com/patchstack-widget.js';

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
  prebuildWired: boolean;
  postbuildWired: boolean;
  widgetInstalled: boolean;
  /** False when the widget is present but its userToken isn't the site UUID. */
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
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export function detectPackageManager(cwd: string): PackageManager {
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
  try {
    const config = await resolveConfig({ cwd });
    siteUuid = config.siteUuid;
    if (siteUuid !== null) {
      claimUrl = buildClaimUrl(config.endpoint, siteUuid);
    }
    if (config.endpoint !== DEFAULT_ENDPOINT) {
      endpointOverride = config.endpoint;
    }
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

  return {
    projectName: pkg?.name ?? null,
    hasPackageJson: pkg !== null,
    packageManager,
    installed,
    siteUuid,
    claimUrl,
    endpointOverride,
    // bun run doesn't execute npm-style pre/post scripts, so chaining inside
    // the build script itself also counts as wired (and is what we suggest on bun).
    prebuildWired:
      (pkg?.scripts?.prebuild ?? '').includes('patchstack-connect scan') ||
      (pkg?.scripts?.build ?? '').includes('patchstack-connect scan'),
    postbuildWired:
      (pkg?.scripts?.postbuild ?? '').includes('patchstack-connect mark-build') ||
      (pkg?.scripts?.build ?? '').includes('patchstack-connect mark-build'),
    widgetInstalled: widget.found,
    widgetTokenMatches: widget.uuidMatches,
    framework: stack.framework,
    widgetFileHint: resolveWidgetFileHint(cwd, stack.framework),
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
    state.widgetInstalled && state.widgetTokenMatches !== false,
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
  if (state.siteUuid !== null) {
    lines.push(done(`Site provisioned (${state.siteUuid})`));
  } else {
    lines.push(todo('Provision the site — run the first scan'));
    lines.push(detail('→ npx @patchstack/connect scan'));
    lines.push(detail('Reads the lockfile, registers the project, writes .patchstackrc.json,'));
    lines.push(detail('and prints a claim URL — show that URL to the user; never open it yourself.'));
  }

  // 3. Build hooks
  if (state.prebuildWired && state.postbuildWired) {
    lines.push(done('Build hooks wired (scan before builds, mark-build after)'));
  } else if (state.packageManager === 'bun') {
    // bun run skips npm-style pre/post scripts, so chain inside the build script.
    lines.push(todo('Wire builds — chain into the package.json build script (bun skips pre/post hooks)'));
    lines.push(detail('→ "build": "patchstack-connect scan && <existing build command> && patchstack-connect mark-build"'));
  } else {
    lines.push(todo('Wire builds — add to package.json scripts (chain with && if a hook exists)'));
    if (!state.prebuildWired) {
      lines.push(detail('→ "prebuild": "patchstack-connect scan"'));
    }
    if (!state.postbuildWired) {
      lines.push(detail('→ "postbuild": "patchstack-connect mark-build"'));
    }
  }

  // 4. Disclosure widget
  const widgetOk = state.widgetInstalled && state.widgetTokenMatches !== false;
  if (widgetOk) {
    lines.push(done('Disclosure widget installed'));
  } else if (state.widgetInstalled) {
    lines.push(todo("Disclosure widget found, but its userToken doesn't match this project's site UUID"));
    lines.push(detail(`→ a wrong userToken makes the widget silently no-op; set it to '${state.siteUuid}'`));
  } else {
    lines.push(todo('Add the "Report a vulnerability" widget'));
    const placement =
      state.widgetFileHint !== null
        ? `→ add to ${state.widgetFileHint}, just before </body> (via the framework's HTML/layout mechanism):`
        : "→ add just before </body> via the framework's HTML/layout mechanism (never a JS entry point):";
    lines.push(detail(placement));
    lines.push(detail(`  <script src="${WIDGET_SCRIPT_URL}"></script>`));
    const token = state.siteUuid ?? '<SITE_UUID from .patchstackrc.json — run scan first>';
    lines.push(detail(`  <script>PatchstackWidget.init({ userToken: '${token}' });</script>`));
    lines.push(detail('The userToken is public by design — it ships in client-side HTML.'));
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
    lines.push(detail('The claim URL appears after the first scan (re-print any time with `status`).'));
  }

  const remaining = countRemainingSteps(state);
  lines.push('');
  if (remaining === 0) {
    lines.push(
      done(
        paint(
          ANSI.bold,
          'All setup steps complete. Commit .patchstackrc.json, package.json, and the file carrying the widget snippet.',
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
