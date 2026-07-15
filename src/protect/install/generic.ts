// Generic fallback for stacks no built-in adapter matches. Rather than silently skip, we scaffold
// a framework-agnostic guard, print a wiring plan (with best-effort entry-point detection), and
// provide a `--check` verifier — so the builder's own agent can finish the wiring and confirm it,
// entirely through the CLI (no server, no hosted infra).

import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { read, templatesDir } from './util.js';
import type { WireOptions, VerifyResult } from './types.js';

const GUARD_MARKER = 'patchstack/guard';

function genericDir(cwd: string): string {
  return existsSync(join(cwd, 'src')) ? 'src/patchstack' : 'patchstack';
}

export function scaffoldGeneric(cwd: string, opts: WireOptions, guardTemplate = 'generic-guard.ts'): { changed: string[]; dir: string } {
  const templates = templatesDir();
  const dir = genericDir(cwd);
  const dst = join(cwd, dir);
  mkdirSync(dst, { recursive: true });
  copyFileSync(join(templates, guardTemplate), join(dst, 'guard.ts'));
  const changed = [`${dir}/guard.ts`];
  const rulesDst = join(dst, 'rules.json');
  if (opts.demo || !existsSync(rulesDst)) {
    copyFileSync(join(templates, opts.demo ? 'demo-rules.json' : 'rules.json'), rulesDst);
    changed.push(`${dir}/rules.json`);
  }
  return { changed, dir };
}

// Best-effort: likely server entry files + whether Express is a dependency.
function candidateEntries(cwd: string): string[] {
  const names = [
    'src/server.ts', 'src/server.js', 'src/index.ts', 'src/index.js', 'src/app.ts', 'src/app.js',
    'src/main.ts', 'server.ts', 'server.js', 'index.ts', 'index.js', 'app.ts', 'app.js',
  ];
  const hits = names.filter((n) => existsSync(join(cwd, n)));
  try {
    const pkg = JSON.parse(read(join(cwd, 'package.json')));
    if (typeof pkg.main === 'string' && existsSync(join(cwd, pkg.main))) hits.push(pkg.main);
  } catch {
    /* ignore */
  }
  return [...new Set(hits)];
}

function usesExpress(cwd: string): boolean {
  try {
    const pkg = JSON.parse(read(join(cwd, 'package.json')));
    return Boolean({ ...pkg.dependencies, ...pkg.devDependencies }.express);
  } catch {
    return false;
  }
}

export function wiringPlan(cwd: string, dir: string): string {
  const entries = candidateEntries(cwd);
  const express = usesExpress(cwd);
  const lines = [
    `no built-in adapter matched this stack — scaffolded a generic guard at ${dir}/guard.ts + ${dir}/rules.json.`,
    'Finish by wiring it into your server (pick the one that fits):',
    `  • Web-Fetch entry:  export default { fetch: protectFetch(yourHandler) }   // import from "${dir}/guard"`,
    `  • Node / Express:   app.use(patchstackMiddleware)                          // add before your routes`,
    entries.length
      ? `Likely server ${entries.length === 1 ? 'entry' : 'entries'}: ${entries.join(', ')}${express ? '  (Express detected)' : ''}.`
      : 'Could not locate a server entry — wire it wherever requests enter your app.',
    'Then confirm it is hooked up:  npx patchstack-connect protect --check',
  ];
  return lines.join('\n');
}

export function genericVerify(cwd: string): VerifyResult {
  const dir = genericDir(cwd);
  const scaffolded = existsSync(join(cwd, dir, 'guard.ts'));
  const imported = scaffolded && guardIsImported(cwd, join(cwd, dir, 'guard.ts'));
  return {
    wired: scaffolded && imported,
    checks: [
      { label: 'generic guard scaffolded', ok: scaffolded, hint: 'run `patchstack-connect protect`' },
      {
        label: 'guard imported into a server entry',
        ok: imported,
        hint: `import { protectFetch } (or patchstackMiddleware) from "${dir}/guard" and wire it into your request path`,
      },
    ],
  };
}

function guardIsImported(cwd: string, guardPath: string): boolean {
  const root = existsSync(join(cwd, 'src')) ? join(cwd, 'src') : cwd;
  let found = false;
  const walk = (d: string): void => {
    if (found) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (found) return;
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(name) && p !== guardPath) {
        try {
          if (readFileSync(p, 'utf8').includes(GUARD_MARKER)) found = true;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root);
  return found;
}
