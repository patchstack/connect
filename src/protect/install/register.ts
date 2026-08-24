// Shared "register-into-app" wiring for adapters whose framework exposes a mutable app instance you
// hook a guard onto (Express `app.use`, Fastify `app.register`, NestJS `app.use` on main.ts). Scaffold
// the guard, then insert the registration call right after the app instance is created — dependency-free
// anchor + #region-marker patching, idempotent.

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { read, log } from './util.js';
import { scaffoldGeneric } from './generic.js';
import { findAppInstance, importSpecifier } from './find-app.js';
import { lastTopLevelImportLine, isTopLevelLine, inSameBlockAfter, parses } from './source-scope.js';
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
  /** Scaffold but leave the app untouched when the preferred anchor is absent. */
  requireCallAfter?: boolean;
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

function guardTarget(cwd: string, entryRel: string, spec: RegisterSpec): GuardTarget {
  if (/\.cjs$/.test(entryRel) || (/\.js$/.test(entryRel) && packageType(cwd) !== 'module')) {
    if (spec.guardTemplateCjs) {
      return {
        template: spec.guardTemplateCjs,
        file: 'guard.cjs',
        importLine: (name, target) => `const { ${name} } = require("${target}");`,
        preserveExtension: true,
      };
    }
  } else if (/\.(?:js|mjs)$/.test(entryRel) && spec.guardTemplateEsm) {
    return {
      template: spec.guardTemplateEsm,
      file: entryRel.endsWith('.mjs') ? 'guard.mjs' : 'guard.js',
      importLine: (name, target) => `import { ${name} } from "${target}";`,
      preserveExtension: true,
    };
  }

  return {
    template: spec.guardTemplate,
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

  const target = guardTarget(cwd, entry.relPath, spec);
  const { changed, dir } = scaffoldGeneric(cwd, opts, target.template, target.file);

  const p = join(cwd, entry.relPath);
  const s = read(p);
  if (s.includes(spec.importName)) {
    log(`${entry.relPath} already wired`);
    return { ok: true, changed };
  }

  const sourceLines = s.split('\n');
  const sourceAppIdx = sourceLines.findIndex((line) => spec.appRe.test(line));
  const requiredAnchor = spec.callAfter?.(entry.appVar);
  if (
    spec.requireCallAfter &&
    requiredAnchor &&
    !sourceLines.some((line, index) => index > sourceAppIdx && requiredAnchor.test(line))
  ) {
    log(`${entry.relPath} body-parser anchor not found — scaffolded guard; ${spec.manualHint}`);
    return { ok: true, changed };
  }

  const importLine = target.importLine(
    spec.importName,
    importSpecifier(entry.relPath, `${dir}/${target.file}`, target.preserveExtension),
  );
  const lines = s.split('\n');

  // The guard binding has to land at MODULE scope. A `require()` inside a helper reads the same as one at
  // the top of the file, and a binding placed after it exists only inside that helper — while the
  // registration statement below stays top level and refers to a name that is not there.
  const lastImport = lastTopLevelImportLine(s);
  const importIdx = lastImport === -1 ? firstStatementLine(lines) : lastImport + 1;
  lines.splice(importIdx, 0, importLine);

  // Recomputed after the insert, because the import line shifted everything below it.
  const appIdx = lines.findIndex((l) => spec.appRe.test(l));
  if (appIdx !== -1) {
    const preferred = spec.callAfter?.(entry.appVar);
    const preferredIdx = preferred
      ? lines.findIndex((line, index) => index > appIdx && preferred.test(line))
      : -1;
    const callIdx = preferredIdx === -1 ? appIdx : preferredIdx;
    lines.splice(callIdx + 1, 0, REGION, spec.call(entry.appVar), '// #endregion patchstack');
  }

  const patched = lines.join('\n');
  writeFileSync(p, patched);

  // Then check the file we just wrote. An edit that leaves an entry point unparseable takes the whole app
  // down, and it is our edit — so it is reverted and reported rather than left for the next `npm start`.
  const parsed = parses(p);
  if (parsed === false) {
    writeFileSync(p, s);
    log(`${entry.relPath} would not parse after patching — reverted; ${spec.manualHint}`);
    return { ok: true, changed };
  }

  changed.push(entry.relPath);
  log(`patched ${entry.relPath} (${spec.call(entry.appVar).trim()})`);
  return { ok: true, changed: [...new Set(changed)] };
}

/**
 * Where to put an import in a file that has none: after any leading comment block or shebang, before the
 * first statement. Prepending blindly would land above a `#!` line, which stops being a shebang.
 */
function firstStatementLine(lines: string[]): number {
  let i = 0;
  if ((lines[0] ?? '').startsWith('#!')) i = 1;
  while (i < lines.length) {
    const line = (lines[i] ?? '').trim();
    if (line !== '' && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*')) break;
    i++;
  }

  return i;
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
  const ordered = anchor ? anchorIndex !== -1 && callIndex > anchorIndex : callIndex !== -1;

  // Two scope questions, and they have different answers.
  //
  // The IMPORT must be at module scope. Checking only that the name appears in the file is what let a
  // binding nested inside a helper verify green: the symbol is there, in the text, and undefined where the
  // registration runs.
  //
  // The REGISTRATION must be in the same block as the app instance — not at module scope, because some
  // frameworks only have an app inside an async bootstrap function, and that is where it belongs. What it
  // must not be is in a different function from the instance it registers on.
  const importIndex = entryLines.findIndex((line) => line.includes(spec.importName) && !line.includes(spec.call(entry?.appVar ?? '')));
  const importAtTopLevel = importIndex !== -1 && isTopLevelLine(entrySource, importIndex);
  const appIndex = entry ? entryLines.findIndex((line) => spec.appRe.test(line)) : -1;
  const callInAppScope = callIndex !== -1 && inSameBlockAfter(entrySource, appIndex, callIndex);
  const wired = importAtTopLevel && callInAppScope && ordered;

  return {
    wired: scaffolded && wired,
    checks: [
      { label: `${spec.label} guard scaffolded`, ok: scaffolded, hint: 'run `patchstack-connect protect`' },
      { label: `guard registered on the ${spec.label}`, ok: wired, hint: spec.manualHint },
    ],
  };
}
