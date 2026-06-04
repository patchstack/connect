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

// Probed in order; the first match wins, so more specific lockfiles must come
// before fallbacks. bun has no standalone parser, so it falls back to walking
// node_modules.
const LOCKFILE_SPECS: ReadonlyArray<{
  filename: LockfileFilename;
  strategy: DetectionStrategy;
}> = [
  { filename: 'package-lock.json', strategy: 'npm-lockfile' },
  { filename: 'bun.lock', strategy: 'node-modules-walk' },
  { filename: 'bun.lockb', strategy: 'node-modules-walk' },
  { filename: 'pnpm-lock.yaml', strategy: 'pnpm-lockfile' },
  { filename: 'yarn.lock', strategy: 'yarn-lockfile' },
];

export async function detectLockfile(cwd: string): Promise<DetectedLockfile> {
  for (const { filename, strategy } of LOCKFILE_SPECS) {
    const filePath = path.join(cwd, filename);
    if (await exists(filePath)) {
      return { ecosystem: 'npm', filePath, filename, strategy };
    }
  }

  throw new PatchstackError(
    `No lockfile found in ${cwd}. Expected one of: package-lock.json, bun.lock, bun.lockb, yarn.lock, pnpm-lock.yaml.`,
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
