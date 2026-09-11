import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Stats } from 'node:fs';

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  createMode?: number;
  preserveMode?: boolean;
}

type FileContent = string | Uint8Array;

function pathError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'EINVAL' });
}

function existingEntry(path: string): Stats | null {
  try {
    return lstatSync(path) as Stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertWritableTarget(target: string): Stats | null {
  const entry = existingEntry(target);
  if (entry?.isSymbolicLink()) throw pathError(`refusing to replace symbolic link: ${target}`);
  if (entry && !entry.isFile()) throw pathError(`refusing to replace non-file path: ${target}`);
  return entry;
}

/** Replace one regular file from a randomized sibling, preserving its current mode by default. */
export function atomicWriteFileSync(
  target: string,
  content: FileContent,
  options: AtomicWriteOptions = {},
): void {
  const current = assertWritableTarget(target);
  const preserveMode = options.preserveMode !== false;
  const exactMode = options.mode
    ?? (preserveMode && current ? current.mode & 0o7777 : options.createMode);
  const temporary = join(dirname(target), `.${randomUUID()}.patchstack-tmp`);
  let descriptor: number | null = null;

  try {
    descriptor = openSync(temporary, 'wx', exactMode ?? 0o666);
    writeFileSync(descriptor, content, options.encoding);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (exactMode !== undefined) chmodSync(temporary, exactMode);

    try {
      renameSync(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || (code !== 'EEXIST' && code !== 'EPERM')) throw error;
      // Windows does not replace an existing path with rename. The target was checked above; unlinking
      // removes the directory entry itself and never follows it.
      try {
        unlinkSync(target);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      }
      renameSync(temporary, target);
    }
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Best-effort cleanup after the original write error.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary was either never created or has already been renamed.
    }
    throw error;
  }
}

function projectTarget(cwd: string, target: string, allowRoot = false): { root: string; path: string; parts: string[] } {
  const logicalRoot = resolve(cwd);
  const logicalTarget = isAbsolute(target) ? resolve(target) : resolve(logicalRoot, target);
  const rel = relative(logicalRoot, logicalTarget);
  if ((!allowRoot && rel === '') || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw pathError(`path is outside the project: ${target}`);
  }

  const root = realpathSync(logicalRoot);
  return { root, path: rel === '' ? root : join(root, rel), parts: rel === '' ? [] : rel.split(sep) };
}

function assertProjectParents(root: string, parts: string[]): void {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const entry = existingEntry(current);
    if (entry === null) throw Object.assign(new Error(`project directory does not exist: ${current}`), { code: 'ENOENT' });
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw pathError(`project path contains a non-directory or symbolic link: ${current}`);
    }
  }
}

/** Create a directory beneath a project root without traversing linked path components. */
export function ensureProjectDirectorySync(cwd: string, target: string): string {
  const resolved = projectTarget(cwd, target, true);
  let current = resolved.root;
  for (const part of resolved.parts) {
    current = join(current, part);
    let entry = existingEntry(current);
    if (entry === null) {
      mkdirSync(current);
      entry = lstatSync(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw pathError(`project path contains a non-directory or symbolic link: ${current}`);
    }
  }
  return resolved.path;
}

/** Atomically replace a regular file beneath a project root without traversing project symlinks. */
export function writeProjectFileSync(
  cwd: string,
  target: string,
  content: FileContent,
  options: AtomicWriteOptions = {},
): void {
  const resolved = projectTarget(cwd, target);
  assertProjectParents(resolved.root, resolved.parts);
  atomicWriteFileSync(resolved.path, content, options);
}

/** Copy a template into a project using the same destination checks and replacement policy. */
export function copyProjectFileSync(cwd: string, source: string, target: string): void {
  const content = readFileSync(source);
  const sourceMode = statSync(source).mode & 0o7777;
  writeProjectFileSync(cwd, target, content, { createMode: sourceMode });
}
