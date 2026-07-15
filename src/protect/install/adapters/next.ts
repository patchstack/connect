// Adapter: Next.js. Wires the guard as edge middleware (request-phase WAF + egress SSRF).
// If the app has no middleware yet, scaffolds `middleware.ts` (+ patchstack.rules.json). If a
// middleware file already exists, we do NOT clobber it — we scaffold the rules and print a plan
// (add the guard to your middleware), so an existing middleware is never silently overwritten.

import { writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { read, log, templatesDir } from '../util.js';
import type { Adapter, WireOptions, WireResult, VerifyResult } from '../types.js';

function hasNextDep(cwd: string): boolean {
  try {
    const pkg = JSON.parse(read(join(cwd, 'package.json')));
    return Boolean({ ...pkg.dependencies, ...pkg.devDependencies }.next);
  } catch {
    return false;
  }
}

// Next reads middleware from `middleware.ts` at the project root, or `src/middleware.ts` when the
// app uses a `src/` dir. Return the existing one if present, else the conventional target.
function middlewareInfo(cwd: string): { relDir: string; relFile: string; exists: boolean } {
  const candidates = ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js'];
  for (const rel of candidates) {
    if (existsSync(join(cwd, rel))) return { relDir: rel.includes('/') ? 'src' : '.', relFile: rel, exists: true };
  }
  const useSrc = existsSync(join(cwd, 'src'));
  return { relDir: useSrc ? 'src' : '.', relFile: useSrc ? 'src/middleware.ts' : 'middleware.ts', exists: false };
}

function detect(cwd: string): boolean {
  return hasNextDep(cwd);
}

function rulesFile(relDir: string): string {
  return relDir === '.' ? 'patchstack.rules.json' : `${relDir}/patchstack.rules.json`;
}

function wire(cwd: string, opts: WireOptions): WireResult {
  const templates = templatesDir();
  const mw = middlewareInfo(cwd);
  const dir = join(cwd, mw.relDir === '.' ? '' : mw.relDir);
  mkdirSync(dir, { recursive: true });

  // Co-locate the rules next to the middleware (the template imports ./patchstack.rules.json).
  const rulesDst = join(dir, 'patchstack.rules.json');
  const changed: string[] = [];
  if (opts.demo || !existsSync(rulesDst)) {
    copyFileSync(join(templates, opts.demo ? 'demo-rules.json' : 'rules.json'), rulesDst);
    changed.push(rulesFile(mw.relDir));
  }

  const mwPath = join(cwd, mw.relFile);
  const existing = mw.exists ? read(mwPath) : '';
  if (mw.exists && !existing.includes('patchstack-next')) {
    // Don't overwrite the app's own middleware — leave it, and tell the user how to add the guard.
    log(
      `existing ${mw.relFile} left untouched — scaffolded ${rulesFile(mw.relDir)}; add the guard to your ` +
        `middleware: import { createProtection } from "@patchstack/connect/protect", run fetchGuard() on the ` +
        `request, and return the block Response. Then: npx patchstack-connect protect --check`,
    );
    return { ok: true, changed };
  }

  // Fresh (or already-ours) → write the managed middleware.
  copyFileSync(join(templates, 'next-middleware.ts'), mwPath);
  changed.push(mw.relFile);
  log(mw.exists ? `refreshed ${mw.relFile} (Patchstack middleware)` : `scaffolded ${mw.relFile} (Patchstack middleware)`);
  return { ok: true, changed: [...new Set(changed)] };
}

function verify(cwd: string): VerifyResult {
  const mw = middlewareInfo(cwd);
  const present = mw.exists && read(join(cwd, mw.relFile)).includes('patchstack-next');
  const rulesPresent = existsSync(join(cwd, rulesFile(mw.relDir)));
  return {
    wired: present && rulesPresent,
    checks: [
      { label: 'Patchstack middleware present', ok: present, hint: `run \`patchstack-connect protect\` (writes ${mw.relFile})` },
      { label: 'rules co-located with the middleware', ok: rulesPresent, hint: 'run `patchstack-connect protect`' },
    ],
  };
}

export const nextAdapter: Adapter = {
  name: 'nextjs',
  label: 'Next.js',
  detect,
  wire,
  verify,
};
