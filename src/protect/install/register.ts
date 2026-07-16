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
  /** Optional JavaScript templates for apps that execute their source files directly. */
  guardTemplateEsm?: string;
  guardTemplateCjs?: string;
  importName: string; // named export the entry imports from the guard
  call: (appVar: string) => string; // the registration statement, e.g. `${v}.use(patchstackMiddleware);`
  /** Prefer a registration anchor after app creation, such as Express's JSON body parser. */
  callAfter?: (appVar: string) => RegExp;
  /** Scaffold but leave the app untouched when the preferred anchor is absent — unless a fallback
   *  guard is provided below. */
  requireCallAfter?: boolean;
  /** Guard templates used when `callAfter` is required but its anchor is absent (e.g. an Express app
   *  with no body parser). These MUST self-buffer the request body and mount right after app creation,
   *  since there is no parsed `req.body` to read. When set, the app is wired instead of skipped. */
  fallbackGuardTemplate?: string;
  fallbackGuardTemplateEsm?: string;
  fallbackGuardTemplateCjs?: string;
  label: string; // human label for logs / verify checks, e.g. 'Express app'
  manualHint: string; // guidance when no app-instance site is found
}

const REGION = '// #region patchstack (managed by patchstack-connect protect — do not edit)';

interface GuardTarget {
  template: string;
  file: string;
  importLine: (name: string, specifier: string) => string;
  preserveExtension: boolean;
}

function guardTarget(cwd: string, entryRel: string, spec: RegisterSpec, useFallback = false): GuardTarget {
  // The fallback guard set (self-buffering) is used when the preferred anchor is absent — see wireRegister.
  const baseTemplate = useFallback && spec.fallbackGuardTemplate ? spec.fallbackGuardTemplate : spec.guardTemplate;
  const esmTemplate = useFallback ? spec.fallbackGuardTemplateEsm : spec.guardTemplateEsm;
  const cjsTemplate = useFallback ? spec.fallbackGuardTemplateCjs : spec.guardTemplateCjs;

  if (/\.cjs$/.test(entryRel) || (/\.js$/.test(entryRel) && packageType(cwd) !== 'module')) {
    if (cjsTemplate) {
      return {
        template: cjsTemplate,
        file: 'guard.cjs',
        importLine: (name, target) => `const { ${name} } = require("${target}");`,
        preserveExtension: true,
      };
    }
  } else if (/\.(?:js|mjs)$/.test(entryRel) && esmTemplate) {
    return {
      template: esmTemplate,
      file: entryRel.endsWith('.mjs') ? 'guard.mjs' : 'guard.js',
      importLine: (name, target) => `import { ${name} } from "${target}";`,
      preserveExtension: true,
    };
  }

  return {
    template: baseTemplate,
    file: 'guard.ts',
    importLine: (name, target) => `import { ${name} } from "${target}";`,
    preserveExtension: false,
  };
}

function packageType(cwd: string): string | undefined {
  try {
    return JSON.parse(read(join(cwd, 'package.json'))).type;
  } catch {
    return undefined;
  }
}

export function wireRegister(cwd: string, opts: WireOptions, spec: RegisterSpec): WireResult {
  const entry = findAppInstance(cwd, spec.appRe);
  if (!entry) {
    const { changed } = scaffoldGeneric(cwd, opts, spec.guardTemplate);
    log(`${spec.label} not located — scaffolded guard; ${spec.manualHint}`);
    return { ok: true, changed };
  }

  const p = join(cwd, entry.relPath);
  const s = read(p);
  const sourceLines = s.split('\n');
  const sourceAppIdx = sourceLines.findIndex((line) => spec.appRe.test(line));
  const requiredAnchor = spec.callAfter?.(entry.appVar);
  const anchorMissing =
    !!requiredAnchor && !sourceLines.some((line, index) => index > sourceAppIdx && requiredAnchor.test(line));

  // When the preferred anchor (e.g. Express's body parser) is required but absent, use the adapter's
  // self-buffering fallback guard mounted right after app creation, if it provides one. Only when there
  // is no fallback do we scaffold the default guard and leave the app for the user to wire by hand.
  const useFallback = spec.requireCallAfter === true && anchorMissing && spec.fallbackGuardTemplate != null;
  const giveUp = spec.requireCallAfter === true && anchorMissing && !useFallback;

  const target = guardTarget(cwd, entry.relPath, spec, useFallback);
  const { changed, dir } = scaffoldGeneric(cwd, opts, target.template, target.file);

  if (s.includes(spec.importName)) {
    log(`${entry.relPath} already wired`);
    return { ok: true, changed };
  }

  if (giveUp) {
    log(`${entry.relPath} body-parser anchor not found — scaffolded guard; ${spec.manualHint}`);
    return { ok: true, changed };
  }

  const importLine = target.importLine(
    spec.importName,
    importSpecifier(entry.relPath, `${dir}/${target.file}`, target.preserveExtension),
  );
  const lines = s.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:import\b|(?:const|let|var)\s+.+?=\s*require\()/.test(lines[i] ?? '')) lastImport = i;
  }
  lines.splice(lastImport + 1, 0, importLine);
  const appIdx = lines.findIndex((l) => spec.appRe.test(l));
  if (appIdx !== -1) {
    const preferred = spec.callAfter?.(entry.appVar);
    const preferredIdx = preferred
      ? lines.findIndex((line, index) => index > appIdx && preferred.test(line))
      : -1;
    const callIdx = preferredIdx === -1 ? appIdx : preferredIdx;
    lines.splice(callIdx + 1, 0, REGION, spec.call(entry.appVar), '// #endregion patchstack');
  }
  writeFileSync(p, lines.join('\n'));
  changed.push(entry.relPath);
  log(`patched ${entry.relPath} (${spec.call(entry.appVar).trim()})`);
  return { ok: true, changed: [...new Set(changed)] };
}

export function verifyRegister(cwd: string, spec: RegisterSpec): VerifyResult {
  const dir = existsSync(join(cwd, 'src')) ? 'src/patchstack' : 'patchstack';
  const entry = findAppInstance(cwd, spec.appRe);
  const target = entry ? guardTarget(cwd, entry.relPath, spec) : null;
  const scaffolded = target ? existsSync(join(cwd, dir, target.file)) : false;
  const entrySource = entry ? read(join(cwd, entry.relPath)) : '';
  const entryLines = entrySource.split('\n');
  const anchor = entry && spec.callAfter ? spec.callAfter(entry.appVar) : null;
  const anchorIndex = anchor ? entryLines.findIndex((line) => anchor.test(line)) : -1;
  const callIndex = entry ? entryLines.findIndex((line) => line.includes(spec.call(entry.appVar))) : -1;
  // Anchor present → the guard must sit after it. Anchor absent (e.g. no body parser, so the
  // self-buffering fallback guard was mounted right after app creation) → only its presence matters.
  const ordered = anchor && anchorIndex !== -1 ? callIndex > anchorIndex : callIndex !== -1;
  const wired = entrySource.includes(spec.importName) && ordered;
  return {
    wired: scaffolded && wired,
    checks: [
      { label: `${spec.label} guard scaffolded`, ok: scaffolded, hint: 'run `patchstack-connect protect`' },
      { label: `guard registered on the ${spec.label}`, ok: wired, hint: spec.manualHint },
    ],
  };
}
