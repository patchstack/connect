import { access } from 'node:fs/promises';
import path from 'node:path';
import { PatchstackError, type Manifest, type PackageEntry } from '../types.js';
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
  const detected = await detectLockfile(cwd);
  const packages = await runStrategy(detected, cwd);
  return { ecosystem: detected.ecosystem, packages };
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
