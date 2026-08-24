import { access } from 'node:fs/promises';
import path from 'node:path';
import { PatchstackError, type Manifest, type PackageEntry } from '../types.js';
import { disagreements, missingDependencies, readDeclaredDependencyNames } from './consistency.js';
import { parseBunLockfile } from './bun.js';
import { parseNpmLockfile } from './npm.js';
import { walkNodeModules } from './node_modules.js';
import { parsePnpmLockfile } from './pnpm.js';
import { parseYarnLockfile } from './yarn.js';

type LockfileFilename =
  | 'package-lock.json'
  | 'bun.lock'
  | 'bun.lockb'
  | 'yarn.lock'
  | 'pnpm-lock.yaml';

type DetectionStrategy =
  | 'npm-lockfile'
  | 'bun-lockfile'
  | 'node-modules-walk'
  | 'pnpm-lockfile'
  | 'yarn-lockfile';

interface DetectedLockfile {
  ecosystem: 'npm';
  filePath: string;
  filename: LockfileFilename;
  strategy: DetectionStrategy;
}

interface LockfileCandidate {
  filename: LockfileFilename;
  strategy: DetectionStrategy;
}

// Checked in priority order: the first candidate present in `cwd` wins.
const LOCKFILE_CANDIDATES: readonly LockfileCandidate[] = [
  { filename: 'package-lock.json', strategy: 'npm-lockfile' },
  // Read directly, not walked. Bun's isolated layout puts packages under a dot-directory and makes the
  // top level symlinks into it, so a `node_modules` walk finds nothing there — and isolated is the default
  // for new workspaces.
  { filename: 'bun.lock', strategy: 'bun-lockfile' },
  { filename: 'bun.lockb', strategy: 'node-modules-walk' },
  { filename: 'pnpm-lock.yaml', strategy: 'pnpm-lockfile' },
  { filename: 'yarn.lock', strategy: 'yarn-lockfile' },
];

export async function detectLockfile(cwd: string): Promise<DetectedLockfile> {
  // Probe every candidate concurrently, then resolve by declaration order so
  // the result is identical to a sequential first-match scan — but bounded by a
  // single I/O round-trip instead of up to one `stat` per candidate.
  const probed = await Promise.all(
    LOCKFILE_CANDIDATES.map(async (candidate) => {
      const filePath = path.join(cwd, candidate.filename);
      return { ...candidate, filePath, present: await exists(filePath) };
    }),
  );

  const match = probed.find((candidate) => candidate.present);
  if (match) {
    return {
      ecosystem: 'npm',
      filePath: match.filePath,
      filename: match.filename,
      strategy: match.strategy,
    };
  }

  const expected = LOCKFILE_CANDIDATES.map((candidate) => candidate.filename).join(', ');
  throw new PatchstackError(
    `No lockfile found in ${cwd}. Expected one of: ${expected}.`,
    'LOCKFILE_NOT_FOUND',
  );
}

export async function scanLockfile(cwd: string): Promise<Manifest> {
  const candidates = await presentLockfiles(cwd);
  if (candidates.length === 0) {
    // Preserve the exact historical error for the no-lockfile case.
    await detectLockfile(cwd);
  }

  // Validate each source against package.json before trusting it. A lockfile
  // missing declared dependencies is a fossil — e.g. `npm install` planted a
  // package-lock.json once on a bun-managed platform (Lovable), and the native
  // dependency flow never updates it again. Trusting it would freeze the
  // manifest and the build fingerprint while the real dependency set drifts.
  const declared = await readDeclaredDependencyNames(cwd);
  const warnings: string[] = [];
  let firstParsed: { packages: PackageEntry[]; filename: string } | null = null;
  let walkTried = false;

  // Every source is parsed before one is chosen, so a disagreement between two of them can be seen at all.
  // Taking the first source that merely lists the right NAMES is what let a stale lockfile decide the
  // version: a fossil that still names every dependency looks complete, and the version is what decides
  // whether a package is vulnerable.
  const parsedSources: Array<{ packages: PackageEntry[]; filename: string }> = [];

  for (const candidate of candidates) {
    let packages: PackageEntry[];
    try {
      packages = await runStrategy(candidate, cwd);
    } catch {
      continue;
    }
    walkTried ||= candidate.strategy === 'node-modules-walk';
    firstParsed ??= { packages, filename: candidate.filename };
    parsedSources.push({ packages, filename: candidate.filename });
  }

  for (const source of parsedSources) {
    const missing = missingDependencies(declared, source.packages);
    if (missing.length > 0) {
      warnings.push(staleWarning(source.filename, missing));
      continue;
    }

    // Names complete. Now: does any other source that is also name-complete report a different VERSION for
    // a shared package? If so, one of the two is stale in a way no name check can see, and neither can be
    // preferred on the evidence available here — so the installed tree decides, and the disagreement is
    // reported either way.
    const conflicts = otherCompleteSources(parsedSources, source, declared).flatMap((other) =>
      disagreements(source.packages, other.packages).map((conflict) => ({ other: other.filename, conflict })),
    );

    if (conflicts.length === 0) {
      return manifestWith(source.packages, warnings);
    }

    warnings.push(conflictWarning(source.filename, conflicts));
    break; // fall through to node_modules, which is what the build actually loads
  }

  // Last resort: the installed truth. node_modules reflects what the build
  // actually compiles against, whichever package manager wrote it.
  if (!walkTried) {
    try {
      const packages = await walkNodeModules(cwd);
      const missing = missingDependencies(declared, packages);
      if (missing.length > 0) {
        warnings.push(staleWarning('node_modules/', missing));
      }
      warnings.push('Scanned node_modules/ instead. Delete the stale lockfile to silence this warning.');
      return manifestWith(packages, warnings);
    } catch {
      // fall through to the best lockfile we managed to parse
    }
  }

  if (firstParsed === null) {
    const expected = LOCKFILE_CANDIDATES.map((candidate) => candidate.filename).join(', ');
    throw new PatchstackError(
      `No readable lockfile found in ${cwd}. Expected one of: ${expected}.`,
      'LOCKFILE_NOT_FOUND',
    );
  }

  warnings.push(
    `No fully-consistent source found; reporting ${firstParsed.filename}. The manifest may understate the real dependency set.`,
  );

  return manifestWith(firstParsed.packages, warnings);
}

function manifestWith(packages: PackageEntry[], warnings: string[]): Manifest {
  return warnings.length > 0
    ? { ecosystem: 'npm', packages, warnings }
    : { ecosystem: 'npm', packages };
}

/** The other sources that are themselves name-complete — the only ones whose versions are worth comparing. */
function otherCompleteSources(
  all: Array<{ packages: PackageEntry[]; filename: string }>,
  current: { filename: string },
  declared: string[],
): Array<{ packages: PackageEntry[]; filename: string }> {
  return all.filter(
    (source) => source.filename !== current.filename && missingDependencies(declared, source.packages).length === 0,
  );
}

function conflictWarning(
  filename: string,
  conflicts: Array<{ other: string; conflict: { name: string; version: string; otherVersion: string } }>,
): string {
  const shown = conflicts
    .slice(0, 3)
    .map(({ other, conflict }) => `${conflict.name} ${conflict.version} vs ${conflict.otherVersion} in ${other}`)
    .join('; ');

  return (
    `${filename} and another lockfile disagree about installed versions (${shown}` +
    `${conflicts.length > 3 ? `, +${conflicts.length - 3} more` : ''}). ` +
    'Scanned node_modules/ instead. Remove whichever lockfile your package manager does not maintain.'
  );
}

function staleWarning(source: string, missing: string[]): string {
  const sample = missing.slice(0, 3).join(', ');
  const suffix = missing.length > 3 ? `, +${missing.length - 3} more` : '';
  return `${source} looks stale: package.json declares ${missing.length} dependenc${missing.length === 1 ? 'y' : 'ies'} it does not contain (${sample}${suffix}).`;
}

async function presentLockfiles(cwd: string): Promise<DetectedLockfile[]> {
  const probed = await Promise.all(
    LOCKFILE_CANDIDATES.map(async (candidate) => {
      const filePath = path.join(cwd, candidate.filename);
      return { ...candidate, filePath, present: await exists(filePath) };
    }),
  );

  return probed
    .filter((candidate) => candidate.present)
    .map(({ filename, strategy, filePath }) => ({ ecosystem: 'npm' as const, filename, strategy, filePath }));
}

async function runStrategy(
  detected: DetectedLockfile,
  cwd: string,
): Promise<PackageEntry[]> {
  switch (detected.strategy) {
    case 'npm-lockfile':
      return parseNpmLockfile(detected.filePath);
    case 'bun-lockfile':
      return parseBunLockfile(detected.filePath);
    case 'pnpm-lockfile':
      return parsePnpmLockfile(detected.filePath);
    case 'yarn-lockfile':
      return parseYarnLockfile(detected.filePath);
    case 'node-modules-walk':
      return walkNodeModules(cwd);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
