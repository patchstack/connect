// Shared helpers for the `patchstack-connect protect` scaffolder (adapters + orchestrator).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const read = (p: string): string => readFileSync(p, 'utf8');
export const log = (msg: string): void => console.log(`patchstack protect: ${msg}`);

/** True when `name` is in the project's dependencies or devDependencies. */
export function hasDependency(cwd: string, name: string): boolean {
  try {
    const pkg = JSON.parse(read(join(cwd, 'package.json')));
    return Boolean({ ...pkg.dependencies, ...pkg.devDependencies }[name]);
  } catch {
    return false;
  }
}

// Guard templates ship next to the built CLI (dist/protect/templates). Resolve for the built
// layout (this code is bundled into dist/cli.js at the dist root → protect/templates) and the
// source layout (this file lives in src/protect/install/ → ../templates).
const HERE = dirname(fileURLToPath(import.meta.url));
export function templatesDir(): string {
  const builtLayout = join(HERE, 'protect', 'templates'); // built: dist/cli.js → dist/protect/templates
  const candidates = [
    builtLayout,
    join(HERE, '..', 'templates'), // source: src/protect/install/ → src/protect/templates
    join(HERE, 'templates'),
  ];
  return candidates.find((p) => existsSync(p)) ?? builtLayout;
}
