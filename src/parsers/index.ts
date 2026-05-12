import { access } from 'node:fs/promises';
import path from 'node:path';
import { PatchstackError, type Manifest } from '../types.js';
import { parseNpmLockfile } from './npm.js';

interface DetectedLockfile {
  ecosystem: 'npm';
  filePath: string;
  filename: 'package-lock.json' | 'yarn.lock' | 'pnpm-lock.yaml';
}

export async function detectLockfile(cwd: string): Promise<DetectedLockfile> {
  const npmLock = path.join(cwd, 'package-lock.json');
  if (await exists(npmLock)) {
    return { ecosystem: 'npm', filePath: npmLock, filename: 'package-lock.json' };
  }

  const yarnLock = path.join(cwd, 'yarn.lock');
  if (await exists(yarnLock)) {
    throw new PatchstackError(
      'yarn.lock detected but not yet supported. Run `npm install` to generate a package-lock.json, or open an issue at github.com/patchstack/connect.',
      'LOCKFILE_UNSUPPORTED',
    );
  }

  const pnpmLock = path.join(cwd, 'pnpm-lock.yaml');
  if (await exists(pnpmLock)) {
    throw new PatchstackError(
      'pnpm-lock.yaml detected but not yet supported. Open an issue at github.com/patchstack/connect to request support.',
      'LOCKFILE_UNSUPPORTED',
    );
  }

  throw new PatchstackError(
    `No lockfile found in ${cwd}. Expected one of: package-lock.json, yarn.lock, pnpm-lock.yaml.`,
    'LOCKFILE_NOT_FOUND',
  );
}

export async function scanLockfile(cwd: string): Promise<Manifest> {
  const detected = await detectLockfile(cwd);
  const packages = await parseNpmLockfile(detected.filePath);
  return { ecosystem: detected.ecosystem, packages };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
