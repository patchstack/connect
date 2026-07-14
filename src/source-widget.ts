import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteTextFile } from './atomic-write.js';
import { DEFAULT_ENDPOINT } from './client.js';
import {
  hasLiveHtmlDocument,
  injectSourceWidget,
  inspectSourceWidgetIdentity,
  type SourceWidgetAnchor,
  type SourceWidgetIdentityInspection,
  type SourceWidgetIdentityStatus,
  type SourceWidgetInjectionStatus,
} from './mark-build.js';
import type { StackDescriptor } from './stack.js';

const MAX_SOURCE_SHELL_BYTES = 2 * 1024 * 1024;
const MAX_MANUAL_WIDGET_SEARCH_FILES = 4_000;
const SOURCE_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.vue',
  '.svelte',
  '.astro',
]);
const SEARCH_ROOTS = ['src', 'app', 'pages', 'public'];
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.output',
  '.git',
]);

export type SourceWidgetInstallStatus =
  | 'installed'
  | 'updated'
  | 'unchanged'
  | 'manual-present'
  | 'ambiguous'
  | 'not-found'
  | 'failed';

export interface SourceWidgetInstallResult {
  status: SourceWidgetInstallStatus;
  file?: string;
  /** Every source document covered by a grouped install (Astro or mixed Next routers). */
  files?: string[];
  candidates?: string[];
  message?: string;
}

export interface EnsureSourceWidgetOptions {
  cwd: string;
  siteUuid: string;
  endpoint: string;
  stack?: Pick<StackDescriptor, 'framework' | 'ui' | 'bundler'> | null;
}

export type SourceWidgetPreflightStatus = SourceWidgetIdentityStatus | 'ambiguous';

export interface SourceWidgetShellIdentity {
  file: string;
  identity: SourceWidgetIdentityInspection;
  /** Alternative paths in one framework root share a group; at most one may exist. */
  group?: string;
}

export interface SourceWidgetPreflightResult {
  status: SourceWidgetPreflightStatus;
  /** The one safe static UUID that can be adopted, or null. */
  uuid: string | null;
  uuids: string[];
  /** Only framework-selected global shell files are reported. */
  files: string[];
  shells: SourceWidgetShellIdentity[];
  /** Any live widget loader/init outside the selected global shell; never auto-adopted. */
  externalWidgetShells: SourceWidgetShellIdentity[];
  hasManual: boolean;
  hasManaged: boolean;
  /** null means there is no single configured identity to compare. */
  matchesExpectedUuid: boolean | null;
  /** Framework roots that must be created before sitewide coverage is possible. */
  missingRequiredShells: string[];
}

export interface InspectSourceWidgetPreflightOptions {
  cwd: string;
  stack?: Pick<StackDescriptor, 'framework' | 'ui' | 'bundler'> | null;
  expectedSiteUuid?: string | null;
}

interface SourceCandidate {
  file: string;
  content: string;
  injectionStatus: SourceWidgetInjectionStatus;
  output: string;
  group?: string;
}

interface SourceShellTarget {
  relativePath: string;
  anchor: SourceWidgetAnchor;
  requireFullDocument?: boolean;
  group?: string;
}

interface SourceShellPlan {
  targets: SourceShellTarget[];
  grouped: boolean;
  missingRequiredShells?: string[];
}

const PREFLIGHT_PROBE_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Inspect widget identity only in the framework's selected global source shell.
 * This is suitable before first-site provisioning: a valid legacy UUID can be
 * adopted, while missing/dynamic/invalid/conflicting identity is explicit. It
 * deliberately does not search arbitrary components, examples, or nested apps.
 */
export async function inspectSourceWidgetPreflight(
  options: InspectSourceWidgetPreflightOptions,
): Promise<SourceWidgetPreflightResult> {
  const plan = await sourceShellPlan(options.cwd, options.stack ?? null);
  const shells: SourceWidgetShellIdentity[] = [];

  for (const target of plan.targets) {
    const file = path.resolve(options.cwd, target.relativePath);
    const content = await readSafeSourceFile(file);
    if (
      content === null ||
      (target.requireFullDocument === true && !hasLiveHtmlDocument(content))
    ) {
      continue;
    }

    const identity = inspectSourceWidgetIdentity(content);
    const probe = injectSourceWidget(content, PREFLIGHT_PROBE_UUID, null, {
      anchor: target.anchor,
    });
    if (probe.status === 'unsupported' && identity.status === 'absent') {
      continue;
    }
    shells.push({ file, identity, group: target.group });
  }

  const selectedFiles = new Set(shells.map((shell) => shell.file));
  const externalWidgetShells: SourceWidgetShellIdentity[] = [];
  for (const file of await findExistingWidgetReferences(options.cwd)) {
    if (selectedFiles.has(file)) continue;
    const content = await readSafeSourceFile(file);
    if (content === null) continue;
    const identity = inspectSourceWidgetIdentity(content);
    if (identity.occurrences.length > 0) {
      externalWidgetShells.push({ file, identity });
    }
  }

  if ((!plan.grouped && shells.length > 1) || hasAlternativeCollision(shells)) {
    return preflightResult(
      'ambiguous',
      shells,
      options.expectedSiteUuid,
      externalWidgetShells,
      plan.missingRequiredShells,
    );
  }

  return preflightResult(
    combineShellIdentityStatus(shells.map((shell) => shell.identity)),
    shells,
    options.expectedSiteUuid,
    externalWidgetShells,
    plan.missingRequiredShells,
  );
}

function combineShellIdentityStatus(
  identities: SourceWidgetIdentityInspection[],
): SourceWidgetIdentityStatus {
  const active = identities.filter((identity) => identity.status !== 'absent');
  if (active.length === 0) return 'absent';
  const uuids = new Set(active.flatMap((identity) => identity.uuids));
  if (
    uuids.size > 1 ||
    active.some((identity) => identity.status === 'conflict') ||
    (uuids.size === 1 &&
      active.some(
        (identity) =>
          identity.status !== 'configured' && identity.status !== 'absent',
      ))
  ) {
    return 'conflict';
  }
  if (uuids.size === 1) return 'configured';
  if (active.some((identity) => identity.status === 'invalid')) return 'invalid';
  if (active.some((identity) => identity.status === 'dynamic')) return 'dynamic';
  return 'unconfigured';
}

function hasAlternativeCollision(items: Array<{ group?: string }>): boolean {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.group === undefined) continue;
    const count = (counts.get(item.group) ?? 0) + 1;
    if (count > 1) return true;
    counts.set(item.group, count);
  }
  return false;
}

function preflightResult(
  status: SourceWidgetPreflightStatus,
  shells: SourceWidgetShellIdentity[],
  expectedSiteUuid?: string | null,
  externalWidgetShells: SourceWidgetShellIdentity[] = [],
  missingRequiredShells: string[] = [],
): SourceWidgetPreflightResult {
  const uuids = [
    ...new Set(shells.flatMap((shell) => shell.identity.uuids)),
  ].sort();
  const uuid = status === 'configured' ? uuids[0] ?? null : null;
  return {
    status,
    uuid,
    uuids,
    files: shells.map((shell) => shell.file),
    shells,
    externalWidgetShells,
    hasManual: shells.some((shell) => shell.identity.hasManual),
    hasManaged: shells.some((shell) => shell.identity.hasManaged),
    matchesExpectedUuid:
      uuid === null || expectedSiteUuid == null
        ? null
        : uuid.toLowerCase() === expectedSiteUuid.toLowerCase(),
    missingRequiredShells,
  };
}

/**
 * Immediately install/update the widget in one unambiguous editable source
 * shell. This is deliberately allowlisted: an uncertain framework is reported
 * instead of guessing at arbitrary layout/component files.
 */
export async function ensureSourceWidget(
  options: EnsureSourceWidgetOptions,
): Promise<SourceWidgetInstallResult> {
  let apiBaseUrl: string | null;
  try {
    apiBaseUrl = widgetApiBaseFromEndpoint(options.endpoint);
  } catch (err) {
    return {
      status: 'failed',
      message: `could not derive widget API origin: ${(err as Error).message}`,
    };
  }

  const plan = await sourceShellPlan(options.cwd, options.stack ?? null);
  if ((plan.missingRequiredShells?.length ?? 0) > 0) {
    return {
      status: 'failed',
      message: plan.missingRequiredShells!.join('; '),
    };
  }
  const candidates: SourceCandidate[] = [];

  for (const target of plan.targets) {
    const file = path.resolve(options.cwd, target.relativePath);
    const content = await readSafeSourceFile(file);
    if (
      content === null ||
      (target.requireFullDocument === true && !hasLiveHtmlDocument(content))
    ) {
      continue;
    }
    const injection = injectSourceWidget(content, options.siteUuid, apiBaseUrl, {
      anchor: target.anchor,
    });
    if (injection.status === 'unsupported') {
      continue;
    }
    candidates.push({
      file,
      content,
      injectionStatus: injection.status,
      output: injection.html,
      group: target.group,
    });
  }

  // Search the wider source tree for every live widget reference, including
  // connector-managed tags. A nested tag can otherwise leave pages double-loaded
  // or point at a second UUID even when the selected global shell looks clean.
  const widgetFiles = await findExistingWidgetReferences(options.cwd);
  const candidateFiles = new Set(candidates.map((candidate) => candidate.file));
  const externalWidgetFile = widgetFiles.find((file) => !candidateFiles.has(file));
  if (externalWidgetFile !== undefined) {
    return {
      status: 'failed',
      file: externalWidgetFile,
      message: 'Patchstack loader or initializer is outside the selected global source shell',
    };
  }

  if (candidates.length === 0) {
    return { status: 'not-found' };
  }
  if ((!plan.grouped && candidates.length > 1) || hasAlternativeCollision(candidates)) {
    return {
      status: 'ambiguous',
      candidates: candidates.map((candidate) => candidate.file),
    };
  }

  if (plan.grouped) {
    return applyGroupedCandidates(candidates);
  }

  const candidate = candidates[0]!;
  if (candidate.injectionStatus === 'existing-manual') {
    return { status: 'manual-present', file: candidate.file };
  }
  if (candidate.output === candidate.content) {
    return { status: 'unchanged', file: candidate.file };
  }

  try {
    await atomicWriteTextFile(candidate.file, candidate.output);
  } catch (err) {
    return {
      status: 'failed',
      file: candidate.file,
      message: (err as Error).message,
    };
  }

  return {
    status: candidate.injectionStatus === 'updated' ? 'updated' : 'installed',
    file: candidate.file,
  };
}

async function applyGroupedCandidates(
  candidates: SourceCandidate[],
): Promise<SourceWidgetInstallResult> {
  const files = candidates.map((candidate) => candidate.file);
  const changed = candidates.filter((candidate) => candidate.output !== candidate.content);
  if (changed.length === 0) {
    const allManual = candidates.every(
      (candidate) => candidate.injectionStatus === 'existing-manual',
    );
    return {
      status: allManual ? 'manual-present' : 'unchanged',
      file: candidates[0]?.file,
      files,
    };
  }

  const written: SourceCandidate[] = [];
  try {
    for (const candidate of changed) {
      await atomicWriteTextFile(candidate.file, candidate.output);
      written.push(candidate);
    }
  } catch (err) {
    const rollbackErrors: string[] = [];
    for (const candidate of written.reverse()) {
      try {
        await atomicWriteTextFile(candidate.file, candidate.content);
      } catch (rollbackErr) {
        rollbackErrors.push(`${candidate.file}: ${(rollbackErr as Error).message}`);
      }
    }
    return {
      status: 'failed',
      file: changed[written.length]?.file ?? changed[0]?.file,
      files,
      message:
        (err as Error).message +
        (rollbackErrors.length > 0 ? `; rollback failed: ${rollbackErrors.join('; ')}` : ''),
    };
  }

  return {
    status: changed.some((candidate) => candidate.injectionStatus === 'inserted')
      ? 'installed'
      : 'updated',
    file: candidates[0]?.file,
    files,
  };
}

/** Widget API origin for data-api-base; omitted for the production default. */
export function widgetApiBaseFromEndpoint(endpoint: string): string | null {
  const configured = new URL(endpoint);
  const baseline = new URL(DEFAULT_ENDPOINT);
  if (!['http:', 'https:'].includes(configured.protocol)) {
    throw new Error(`unsupported protocol ${configured.protocol}`);
  }
  return configured.origin === baseline.origin ? null : configured.origin;
}

async function sourceShellPlan(
  cwd: string,
  stack: EnsureSourceWidgetOptions['stack'],
): Promise<SourceShellPlan> {
  const framework = stack?.framework ?? null;
  let grouped = false;
  let paths: string[];
  let anchor: SourceWidgetAnchor = 'body';
  switch (framework) {
    case 'next':
      {
      const appTargets = [
        'src/app/layout.tsx',
        'src/app/layout.jsx',
        'src/app/layout.js',
        'app/layout.tsx',
        'app/layout.jsx',
        'app/layout.js',
      ].map((relativePath) => ({
        relativePath,
        anchor: 'body' as const,
        group: 'next-app-router',
      }));
      const pagesRoots = await nextPagesUiRouteRoots(cwd);
      const documentRoots = pagesRoots.length === 1 ? pagesRoots : ['src/pages', 'pages'];
      const pagesTargets = documentRoots.flatMap((root) =>
        ['tsx', 'jsx', 'js'].map((extension) => ({
          relativePath: `${root}/_document.${extension}`,
          anchor: 'body' as const,
          group: 'next-pages-router',
        })),
      );
      const missingRequiredShells: string[] = [];
      if (pagesRoots.length > 1) {
        missingRequiredShells.push(
          'Next Pages Router routes exist under both src/pages and pages; keep one router root before scanning',
        );
      } else if (
        pagesRoots.length === 1 &&
        !(await hasReadableSourceTarget(cwd, pagesTargets.map((target) => target.relativePath)))
      ) {
        missingRequiredShells.push(
          `Next Pages Router routes were found under ${pagesRoots[0]}, but no editable ${pagesRoots[0]}/_document.{tsx,jsx,js} exists; create that global document before scanning`,
        );
      }
      return {
        grouped: true,
        targets: [...appTargets, ...pagesTargets],
        missingRequiredShells,
      };
      }
    case 'tanstack-start':
      paths = [
        'src/routes/__root.tsx',
        'src/routes/__root.jsx',
        'app/routes/__root.tsx',
        'app/routes/__root.jsx',
      ];
      break;
    case 'sveltekit':
      paths = ['src/app.html'];
      break;
    case 'astro': {
      paths = await astroLayoutPaths(cwd);
      grouped = true;
      return {
        grouped,
        targets: paths.map((relativePath) => ({
          relativePath,
          anchor: 'body',
          requireFullDocument: true,
        })),
      };
    }
    case 'remix':
      paths = ['app/root.tsx', 'app/root.jsx', 'app/root.ts', 'app/root.js'];
      anchor = 'remix-scripts';
      break;
    case 'react-router':
      return {
        grouped: false,
        targets: [
          ...[
            'app/root.tsx',
            'app/root.jsx',
            'app/root.ts',
            'app/root.js',
          ].map((relativePath) => ({
            relativePath,
            anchor: 'remix-scripts' as const,
          })),
          { relativePath: 'index.html', anchor: 'body' },
        ],
      };
    case 'qwik-city':
      paths = ['src/root.tsx', 'src/root.jsx'];
      break;
    case 'gatsby':
      paths = ['src/html.tsx', 'src/html.jsx', 'src/html.ts', 'src/html.js'];
      break;
    case 'nuxt':
      paths = ['app.html'];
      break;
    default:
      paths = stack?.ui === 'angular'
        ? ['src/index.html']
        : ['index.html', 'public/index.html', 'src/index.html', 'src/app.html'];
      break;
  }
  return {
    grouped,
    targets: paths.map((relativePath) => ({ relativePath, anchor })),
  };
}

async function nextPagesUiRouteRoots(cwd: string): Promise<string[]> {
  const roots: string[] = [];
  for (const relativeRoot of ['src/pages', 'pages']) {
    if (await containsNextPagesUiRoute(path.join(cwd, relativeRoot), 0)) {
      roots.push(relativeRoot);
    }
  }
  return roots;
}

async function containsNextPagesUiRoute(directory: string, depth: number): Promise<boolean> {
  if (depth > 8) return false;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (depth === 0 && entry.name === 'api') continue;
      if (await containsNextPagesUiRoute(path.join(directory, entry.name), depth + 1)) {
        return true;
      }
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith('.d.ts')) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx', '.mdx'].includes(extension)) continue;
    if (path.basename(entry.name, extension) === '_document') continue;
    return true;
  }
  return false;
}

async function hasReadableSourceTarget(cwd: string, relativePaths: string[]): Promise<boolean> {
  for (const relativePath of relativePaths) {
    if (await readSafeSourceFile(path.resolve(cwd, relativePath)) !== null) return true;
  }
  return false;
}

async function astroLayoutPaths(cwd: string): Promise<string[]> {
  const layoutsDir = path.join(cwd, 'src', 'layouts');
  const found: string[] = [];

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.astro')) {
        found.push(path.relative(cwd, fullPath));
      }
    }
  };

  await walk(layoutsDir, 0);
  return found.sort();
}

async function readSafeSourceFile(file: string): Promise<string | null> {
  try {
    const stats = await lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SOURCE_SHELL_BYTES) {
      return null;
    }
    const buffer = await readFile(file);
    if (buffer.includes(0)) {
      return null;
    }
    return buffer.toString('utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

async function findExistingWidgetReferences(cwd: string): Promise<string[]> {
  const found: string[] = [];
  const budget = { remaining: MAX_MANUAL_WIDGET_SEARCH_FILES };
  for (const relativeRoot of SEARCH_ROOTS) {
    await searchDirectory(path.join(cwd, relativeRoot), 0, found, budget);
    if (budget.remaining <= 0) break;
  }
  return found;
}

async function searchDirectory(
  directory: string,
  depth: number,
  found: string[],
  budget: { remaining: number },
): Promise<void> {
  if (depth > 6 || budget.remaining <= 0) {
    return;
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (budget.remaining <= 0) return;
    if (entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await searchDirectory(fullPath, depth + 1, found, budget);
      }
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    budget.remaining -= 1;
    const content = await readSafeSourceFile(fullPath);
    if (content !== null && inspectSourceWidgetIdentity(content).occurrences.length > 0) {
      found.push(fullPath);
    }
  }
}
