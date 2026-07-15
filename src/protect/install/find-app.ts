// Locate the source file + variable where an app instance is created, for the register-into-app
// adapters (Express/Fastify/NestJS). Dependency-free: walk src/ (or the repo root) for a source
// file matching `re`, which MUST capture the app variable name in group 1.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

export function findAppInstance(cwd: string, re: RegExp): { relPath: string; appVar: string } | null {
  const root = existsSync(join(cwd, 'src')) ? join(cwd, 'src') : cwd;
  let hit: { relPath: string; appVar: string } | null = null;
  const walk = (dir: string): void => {
    if (hit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (hit) return;
      if (name === 'node_modules' || name === 'patchstack' || name.startsWith('.')) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
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
  walk(root);
  return hit;
}

/** Relative ESM specifier from `fromRel` to `toRel` (both repo-relative, extension stripped). */
export function importSpecifier(fromRel: string, toRel: string): string {
  let spec = relative(dirname(fromRel), toRel).replace(/\\/g, '/').replace(/\.(?:ts|js)$/, '');
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return spec;
}
