import { access } from 'node:fs/promises';
import path from 'node:path';
import { PatchstackError, type Manifest, type PackageEntry } from '../types.js';
import { missingDependencies, readDeclaredDependencyNames } from './consistency.js';
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
  { filename: 'bun.lock', strategy: 'node-modules-walk' },
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

  for (const candidate of candidates) {
    let packages: PackageEntry[];
    try {
      packages = await runStrategy(candidate, cwd);
    } catch {
      continue;
    }
    walkTried ||= candidate.strategy === 'node-modules-walk';
    firstParsed ??= { packages, filename: candidate.filename };

    const missing = missingDependencies(declared, packages);
    if (missing.length === 0) {
      return manifestWith(packages, warnings);
    }
    warnings.push(staleWarning(candidate.filename, missing));
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
