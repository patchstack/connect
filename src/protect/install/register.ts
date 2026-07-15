// Shared "register-into-app" wiring for adapters whose framework exposes a mutable app instance you
// hook a guard onto (Express `app.use`, Fastify `app.register`, NestJS `app.use` on main.ts). Scaffold
// the guard, then insert the registration call right after the app instance is created — dependency-free
// anchor + #region-marker patching, idempotent.

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { read, log } from './util.js';
import { scaffoldGeneric } from './generic.js';
import { findAppInstance, importSpecifier } from './find-app.js';
import type { WireOptions, WireResult, VerifyResult } from './types.js';

export interface RegisterSpec {
  appRe: RegExp; // matches the app-instance line; MUST capture the app var in group 1
  guardTemplate: string; // guard template scaffolded as src/patchstack/guard.ts
  importName: string; // named export the entry imports from the guard
  call: (appVar: string) => string; // the registration statement, e.g. `${v}.use(patchstackMiddleware);`
  label: string; // human label for logs / verify checks, e.g. 'Express app'
  manualHint: string; // guidance when no app-instance site is found
}

const REGION = '// #region patchstack (managed by patchstack-connect protect — do not edit)';

export function wireRegister(cwd: string, opts: WireOptions, spec: RegisterSpec): WireResult {
  const { changed, dir } = scaffoldGeneric(cwd, opts, spec.guardTemplate);
  const entry = findAppInstance(cwd, spec.appRe);
  if (!entry) {
    log(`${spec.label} not located — scaffolded guard; ${spec.manualHint}`);
    return { ok: true, changed };
  }

  const p = join(cwd, entry.relPath);
  const s = read(p);
  if (s.includes(spec.importName)) {
    log(`${entry.relPath} already wired`);
    return { ok: true, changed };
  }

  const importLine = `import { ${spec.importName} } from "${importSpecifier(entry.relPath, `${dir}/guard`)}";`;
  const lines = s.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s*import\b/.test(lines[i] ?? '')) lastImport = i;
  lines.splice(lastImport + 1, 0, importLine);
  const appIdx = lines.findIndex((l) => spec.appRe.test(l));
  if (appIdx !== -1) {
    lines.splice(appIdx + 1, 0, REGION, spec.call(entry.appVar), '// #endregion patchstack');
  }
  writeFileSync(p, lines.join('\n'));
  changed.push(entry.relPath);
  log(`patched ${entry.relPath} (${spec.call(entry.appVar).trim()})`);
  return { ok: true, changed: [...new Set(changed)] };
}

export function verifyRegister(cwd: string, spec: RegisterSpec): VerifyResult {
  const dir = existsSync(join(cwd, 'src')) ? 'src/patchstack' : 'patchstack';
  const scaffolded = existsSync(join(cwd, dir, 'guard.ts'));
  const entry = findAppInstance(cwd, spec.appRe);
  const wired = entry ? read(join(cwd, entry.relPath)).includes(spec.importName) : false;
  return {
    wired: scaffolded && wired,
    checks: [
      { label: `${spec.label} guard scaffolded`, ok: scaffolded, hint: 'run `patchstack-connect protect`' },
      { label: `guard registered on the ${spec.label}`, ok: wired, hint: spec.manualHint },
    ],
  };
}
