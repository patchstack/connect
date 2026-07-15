// Adapter: Fastify (Node). Scaffolds the Fastify guard plugin and registers it on the app —
// `app.register(patchstackFastify)` right after the `fastify()` instance is created.
// Dependency-free anchor + #region-marker patching (same approach as the express adapter).

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { read, log } from '../util.js';
import { scaffoldGeneric } from '../generic.js';
import type { Adapter, WireOptions, WireResult, VerifyResult } from '../types.js';

const APP_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:fastify|Fastify)\(/;
const REGION = '// #region patchstack (managed by patchstack-connect protect — do not edit)';

function hasFastifyDep(cwd: string): boolean {
  try {
    const pkg = JSON.parse(read(join(cwd, 'package.json')));
    return Boolean({ ...pkg.dependencies, ...pkg.devDependencies }.fastify);
  } catch {
    return false;
  }
}

// Find the source file + variable where the Fastify app is created (`const app = fastify()`).
function findFastifyApp(cwd: string): { relPath: string; appVar: string } | null {
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
        const m = APP_RE.exec(src);
        if (m) hit = { relPath: relative(cwd, p).replace(/\\/g, '/'), appVar: m[1]! };
      }
    }
  };
  walk(root);
  return hit;
}

function detect(cwd: string): boolean {
  return hasFastifyDep(cwd) && findFastifyApp(cwd) !== null;
}

function importSpecifier(fromRel: string, toRel: string): string {
  let spec = relative(dirname(fromRel), toRel).replace(/\\/g, '/').replace(/\.(?:ts|js)$/, '');
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return spec;
}

function wire(cwd: string, opts: WireOptions): WireResult {
  const { changed, dir } = scaffoldGeneric(cwd, opts, 'fastify-plugin.ts');
  const entry = findFastifyApp(cwd);
  if (!entry) {
    log('fastify detected but no `= fastify()` site found — scaffolded plugin; register it yourself: app.register(patchstackFastify)');
    return { ok: true, changed };
  }

  const p = join(cwd, entry.relPath);
  let s = read(p);
  if (s.includes('patchstackFastify')) {
    log(`fastify entry ${entry.relPath} already wired`);
    return { ok: true, changed };
  }

  const spec = importSpecifier(entry.relPath, `${dir}/guard`);
  const importLine = `import { patchstackFastify } from "${spec}";`;
  const lines = s.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*import\b/.test(lines[i] ?? '')) lastImport = i;
  lines.splice(lastImport + 1, 0, importLine);
  const appIdx = lines.findIndex((l) => APP_RE.test(l));
  if (appIdx !== -1) {
    lines.splice(appIdx + 1, 0, REGION, `${entry.appVar}.register(patchstackFastify);`, '// #endregion patchstack');
  }
  s = lines.join('\n');
  writeFileSync(p, s);
  changed.push(entry.relPath);
  log(`patched ${entry.relPath} (${entry.appVar}.register(patchstackFastify))`);
  return { ok: true, changed: [...new Set(changed)] };
}

function verify(cwd: string): VerifyResult {
  const dir = existsSync(join(cwd, 'src')) ? 'src/patchstack' : 'patchstack';
  const scaffolded = existsSync(join(cwd, dir, 'guard.ts'));
  const entry = findFastifyApp(cwd);
  const wired = entry ? read(join(cwd, entry.relPath)).includes('patchstackFastify') : false;
  return {
    wired: scaffolded && wired,
    checks: [
      { label: 'Fastify guard plugin scaffolded', ok: scaffolded, hint: 'run `patchstack-connect protect`' },
      {
        label: 'app.register(patchstackFastify) wired into the Fastify app',
        ok: wired,
        hint: 'add `app.register(patchstackFastify)` right after you create your fastify() app',
      },
    ],
  };
}

export const fastifyAdapter: Adapter = {
  name: 'fastify',
  label: 'Fastify (Node)',
  detect,
  wire,
  verify,
};
