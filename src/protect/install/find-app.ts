// Locate the source file + variable where an app instance is created, for the register-into-app
// adapters (Express/Fastify/NestJS). Dependency-free: walk src/ (or the repo root) for a source
// file matching `re`, which MUST capture the app variable name in group 1.

import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

// Build/output/test dirs are skipped so we never patch a COMPILED artifact (e.g. dist/main.js) —
// which would leave the real src/ entry unprotected and vary by machine.
const SKIP_DIRS = new Set([
  'node_modules', 'patchstack', 'dist', 'build', 'out', 'coverage', '.next', '.output', '.svelte-kit',
  'test', 'tests', '__tests__', 'e2e', 'examples', 'fixtures', '__fixtures__',
]);
const MAX_DEPTH = 8;

export function findAppInstance(cwd: string, re: RegExp): { relPath: string; appVar: string } | null {
  const root = existsSync(join(cwd, 'src')) ? join(cwd, 'src') : cwd;
  let hit: { relPath: string; appVar: string } | null = null;
  const walk = (dir: string, depth: number): void => {
    if (hit || depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort(); // deterministic order across machines
    } catch {
      return;
    }
    for (const name of entries) {
      if (hit) return;
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const p = join(dir, name);
      let st;
      try {
        st = lstatSync(p); // lstat, not stat — do NOT follow symlinks (avoids symlink-cycle recursion)
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/\.(?:ts|js|mjs|cjs)$/.test(name)) {
        let src: string;
        try {
          src = readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        const m = re.exec(src);
        if (m) hit = { relPath: relative(cwd, p).replace(/\\/g, '/'), appVar: m[1]! };
      }
    }
  };
  walk(root, 0);
  return hit;
}

/** Relative ESM specifier from `fromRel` to `toRel` (both repo-relative, extension stripped). */
export function importSpecifier(fromRel: string, toRel: string, preserveExtension = false): string {
  let spec = relative(dirname(fromRel), toRel).replace(/\\/g, '/');
  if (!preserveExtension) spec = spec.replace(/\.(?:ts|js)$/, '');
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return spec;
}
