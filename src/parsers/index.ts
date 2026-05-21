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

export async function detectLockfile(cwd: string): Promise<DetectedLockfile> {
  const npmLock = path.join(cwd, 'package-lock.json');
  if (await exists(npmLock)) {
    return {
      ecosystem: 'npm',
      filePath: npmLock,
      filename: 'package-lock.json',
      strategy: 'npm-lockfile',
    };
  }

  const bunLock = path.join(cwd, 'bun.lock');
  if (await exists(bunLock)) {
    return {
      ecosystem: 'npm',
      filePath: bunLock,
      filename: 'bun.lock',
      strategy: 'node-modules-walk',
    };
  }

  const bunLockB = path.join(cwd, 'bun.lockb');
  if (await exists(bunLockB)) {
    return {
      ecosystem: 'npm',
      filePath: bunLockB,
      filename: 'bun.lockb',
      strategy: 'node-modules-walk',
    };
  }

  const pnpmLock = path.join(cwd, 'pnpm-lock.yaml');
  if (await exists(pnpmLock)) {
    return {
      ecosystem: 'npm',
      filePath: pnpmLock,
      filename: 'pnpm-lock.yaml',
      strategy: 'pnpm-lockfile',
    };
  }

  const yarnLock = path.join(cwd, 'yarn.lock');
  if (await exists(yarnLock)) {
    return {
      ecosystem: 'npm',
      filePath: yarnLock,
      filename: 'yarn.lock',
      strategy: 'yarn-lockfile',
    };
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
