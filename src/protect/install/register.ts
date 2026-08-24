// Shared "register-into-app" wiring for adapters whose framework exposes a mutable app instance you
// hook a guard onto (Express `app.use`, Fastify `app.register`, NestJS `app.use` on main.ts). Scaffold
// the guard, then insert the registration call right after the app instance is created — dependency-free
// anchor + #region-marker patching, idempotent.

import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { read, log } from './util.js';
import { scaffoldGeneric } from './generic.js';
import { findAppInstance, importSpecifier } from './find-app.js';
import {
  lastTopLevelImportLine,
  isTopLevelLine,
  inSameBlockAfter,
  parses,
  stripComments,
  maskStringContents,
} from './source-scope.js';
import type { WireOptions, WireResult, VerifyResult } from './types.js';

/**
 * A route or router registration — `app.get(...)`, `app.post(...)`, `app.use('/path', router)`.
 *
 * Used to answer the question verification was not asking: not "is the guard after the body parser" but
 * "is it before every route". A route registered above the guard is served without it, and the guard being
 * correctly placed relative to the parser says nothing about that.
 */
const routeRegistration = (appVar: string) =>
  new RegExp(
    `^\\s*${appVar}\\.(?:get|post|put|patch|delete|head|options|all|route)\\(|` +
      `^\\s*${appVar}\\.use\\(\\s*['"\`]`,
    'm',
  );

/**
 * Route lines that come before `guardIndex`, if any.
 *
 * `app.use('/path', router)` counts: mounting a router registers everything in it. A bare `app.use(fn)` does
 * not — that is middleware, and middleware ordering is what the parser anchor already handles.
 */
export function routesBefore(source: string, appVar: string, guardIndex: number): number[] {
  if (guardIndex < 0) return [];
  const pattern = routeRegistration(appVar);

  return source
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => index < guardIndex && pattern.test(line))
    .map(({ index }) => index + 1); // 1-based, for a message a person reads
}

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

/**
 * Whether this entry file really has the guard wired, and which half is missing if not.
 *
 * Answered on comment-stripped source, because a comment is the cheapest way to put a name in a file
 * without running anything — and the name being present is what made an unwired file read as wired, both
 * to the installer (which then declined to edit it) and to `--check` (which then reported protection).
 *
 * The two halves have different scope rules. The IMPORT must be at module scope, or the name is undefined
 * where the registration runs. The REGISTRATION must be in the same block as the app instance — not at
 * module scope, because some frameworks only have an app inside an async bootstrap function.
 */
interface WiringState {
  importAtTopLevel: boolean;
  callInAppScope: boolean;
  /** The registration is after the anchor the guard needs (a body parser), when the spec names one. */
  ordered: boolean;
  callIndex: number;
  appIndex: number;
}

/** Where the guard was scaffolded, and which file is being asked about — needed to resolve a specifier. */
interface GuardLocation {
  cwd: string;
  /** Repo-relative directory holding the scaffolded guard, e.g. `src/patchstack`. */
  guardDir: string;
}

function wiringState(
  source: string,
  spec: RegisterSpec,
  appVar: string,
  fileRel: string,
  guard: GuardLocation,
): WiringState {
  const code = stripComments(source); // newline-preserving, so these indices are the file's own
  // Same length as `code`, so the two split into matching lines. Strings are blanked because a literal is
  // a place to put code-shaped text that never runs, and the checks below search text.
  const masked = maskStringContents(code);
  const lines = code.split('\n');
  const maskedLines = masked.split('\n');
  const call = spec.call(appVar);

  const callIndex = maskedLines.findIndex((line) => line.includes(call));
  const importIndex = maskedLines.findIndex((line, index) =>
    bindsGuard(lines[index] ?? '', line, spec.importName, call, fileRel, guard),
  );
  const appIndex = maskedLines.findIndex((line) => spec.appRe.test(line));
  const anchor = spec.callAfter ? spec.callAfter(appVar) : null;
  const anchorIndex = anchor ? maskedLines.findIndex((line) => anchor.test(line)) : -1;

  return {
    importAtTopLevel: importIndex !== -1 && isTopLevelLine(code, importIndex),
    callInAppScope: callIndex !== -1 && inSameBlockAfter(code, appIndex, callIndex),
    ordered: anchor ? anchorIndex !== -1 && callIndex > anchorIndex : callIndex !== -1,
    callIndex,
    appIndex,
  };
}

/**
 * Does this line bind the guard's name FROM the guard module?
 *
 * The name alone is not the module. A local file that happens to export `patchstackMiddleware` binds the
 * same identifier and screens nothing, so the specifier is resolved against the file being edited and has
 * to land inside the scaffolded guard directory. Any file in there is ours — which extension the guard got
 * depends on the entry's module format, and a second server in this project may not share it.
 *
 * `maskedLine` is what the shape is matched against, so a string cannot look like a declaration; `line` is
 * the real text, which is where the specifier is read from.
 */
function bindsGuard(
  line: string,
  maskedLine: string,
  importName: string,
  call: string,
  fileRel: string,
  guard: GuardLocation,
): boolean {
  if (!maskedLine.includes(importName) || maskedLine.includes(call)) return false;
  if (!/^\s*(?:import\b|export\s+(?:\*|\{)|(?:const|let|var)\s+[^=]+=\s*require\()/.test(maskedLine)) {
    return false;
  }

  const specifier = /(['"`])([^'"`]*)\1/.exec(line)?.[2];
  if (specifier === undefined || specifier === '') return false;

  const resolved = withoutExtension(resolve(dirname(join(guard.cwd, fileRel)), specifier));
  const dir = resolve(join(guard.cwd, guard.guardDir));

  return resolved === dir || resolved.startsWith(dir + '/') || resolved.startsWith(dir + '\\');
}

function withoutExtension(filePath: string): string {
  return filePath.replace(/\.(?:ts|js|mjs|cjs)$/, '');
}

export function wireRegister(cwd: string, opts: WireOptions, spec: RegisterSpec): WireResult {
  const entry = findAppInstance(cwd, spec.appRe);
  if (!entry) {
    const { changed } = scaffoldGeneric(cwd, opts, spec.guardTemplate);
    log(`${spec.label} not located — scaffolded guard; ${spec.manualHint}`);
    return { ok: true, changed };
  }

  if (entry.others.length > 0) {
    log(
      `${entry.others.map((other) => other.relPath).join(', ')} also start${entry.others.length === 1 ? 's' : ''} a server — wired ${entry.relPath} only; ${spec.manualHint} there too`,
    );
  }

  const target = guardTarget(cwd, entry.relPath, spec);
  const { changed, dir } = scaffoldGeneric(cwd, opts, target.template, target.file);

  const p = join(cwd, entry.relPath);
  const s = read(p);
  const state = wiringState(s, spec, entry.appVar, entry.relPath, { cwd, guardDir: dir });
  if (state.importAtTopLevel && state.callInAppScope) {
    // Wired, but not necessarily in the right place. The guard reads a parsed body, so a registration above
    // the parser screens an empty one — and there is no safe automatic repair for a line somebody else may
    // have written, so it is named rather than moved, and not called wired.
    log(
      state.ordered
        ? `${entry.relPath} already wired`
        : `${entry.relPath} has the guard registered before the body parser, where it cannot read the body — move \`${spec.call(entry.appVar).trim()}\` below the parser`,
    );
    return { ok: true, changed };
  }
  // Half of the wiring present is not wiring. It happens: an interrupted install, a hand-edit that moved
  // one line, a merge that kept one side. Treating the name as proof of the whole thing is what let setup
  // decline to finish the job while reporting success, so the missing half is added and the other left alone.
  if (state.importAtTopLevel || state.callInAppScope) {
    log(
      `${entry.relPath} has the guard ${state.importAtTopLevel ? 'imported but not registered' : 'registered but not imported'} — completing it`,
    );
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
  if (!state.importAtTopLevel) {
    const lastImport = lastTopLevelImportLine(s);
    const importIdx = lastImport === -1 ? firstStatementLine(lines) : lastImport + 1;
    lines.splice(importIdx, 0, importLine);
  }

  // Recomputed after the insert, because the import line shifted everything below it.
  const appIdx = lines.findIndex((l) => spec.appRe.test(l));
  if (appIdx !== -1 && !state.callInAppScope) {
    const preferred = spec.callAfter?.(entry.appVar);
    const preferredIdx = preferred
      ? lines.findIndex((line, index) => index > appIdx && preferred.test(line))
      : -1;
    const callIdx = preferredIdx === -1 ? appIdx : preferredIdx;
    lines.splice(callIdx + 1, 0, REGION, spec.call(entry.appVar), '// #endregion patchstack');
  }

  const patched = lines.join('\n');
  writeFileSync(p, patched);

  // Said at install time, because this is the moment somebody is looking. The guard goes after the body
  // parser — it reads the parsed body — so a route registered above that parser cannot be covered by moving
  // the guard, only by moving the route.
  if (spec.callAfter) {
    const guardIndex = lines.findIndex((line) => line.includes(spec.call(entry.appVar)));
    const early = routesBefore(patched, entry.appVar, guardIndex);
    if (early.length > 0) {
      log(
        `${entry.relPath}: ${early.length} route${early.length === 1 ? '' : 's'} registered before the guard ` +
          `(line${early.length === 1 ? '' : 's'} ${early.join(', ')}) — those are not screened. ` +
          'Move them below the guard, or move your body parser above them.',
      );
    }
  }

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

/**
 * Is this server fully guarded — bound from the guard module, registered on its own app, in the right
 * order, with no route above it?
 *
 * The same question for a second server as for the wired one. Answering it from a filename alone was the
 * gap: an import with no registration under it satisfied a check that could only look for a binding.
 */
function serverIsGuarded(
  cwd: string,
  spec: RegisterSpec,
  server: { relPath: string; appVar: string },
  guardDir: string,
): boolean {
  const source = read(join(cwd, server.relPath));
  const state = wiringState(source, spec, server.appVar, server.relPath, { cwd, guardDir });
  if (!state.importAtTopLevel || !state.callInAppScope || !state.ordered) return false;

  return !spec.callAfter || routesBefore(source, server.appVar, state.callIndex).length === 0;
}

export function verifyRegister(cwd: string, spec: RegisterSpec): VerifyResult {
  const dir = existsSync(join(cwd, 'src')) ? 'src/patchstack' : 'patchstack';
  const entry = findAppInstance(cwd, spec.appRe);
  const target = entry ? guardTarget(cwd, entry.relPath, spec) : null;
  const scaffolded = target ? existsSync(join(cwd, dir, target.file)) : false;
  const entrySource = entry ? read(join(cwd, entry.relPath)) : '';
  const state = entry
    ? wiringState(entrySource, spec, entry.appVar, entry.relPath, { cwd, guardDir: dir })
    : { importAtTopLevel: false, callInAppScope: false, ordered: false, callIndex: -1, appIndex: -1 };
  const wired = state.importAtTopLevel && state.callInAppScope && state.ordered;

  // "After the parser" was the only ordering checked, and it is only half the question. A route registered
  // above the guard is served without it, so reporting the app fully wired would name protection that this
  // route does not have.
  const early = spec.callAfter && entry ? routesBefore(entrySource, entry.appVar, state.callIndex) : [];
  const noEarlyRoutes = early.length === 0;

  // A project can start more than one server, and a guard on one is not a guard on the other. Each is asked
  // the whole question, so a second server that imports the guard without registering it is not counted.
  const unguarded = (entry?.others ?? [])
    .filter((other) => !serverIsGuarded(cwd, spec, other, dir))
    .map((other) => other.relPath);

  return {
    wired: scaffolded && wired && noEarlyRoutes && unguarded.length === 0,
    checks: [
      { label: `${spec.label} guard scaffolded`, ok: scaffolded, hint: 'run `patchstack-connect protect`' },
      { label: `guard registered on the ${spec.label}`, ok: wired, hint: spec.manualHint },
      ...(entry && entry.others.length > 0
        ? [
            {
              label: 'every server in this project has a guard',
              ok: unguarded.length === 0,
              hint:
                unguarded.length === 0
                  ? 'nothing to do'
                  : `${unguarded.join(', ')} start${unguarded.length === 1 ? 's' : ''} a server without one — ${spec.manualHint} there`,
            },
          ]
        : []),
      ...(spec.callAfter
        ? [
            {
              label: 'every route registered after the guard',
              ok: noEarlyRoutes,
              hint: noEarlyRoutes
                ? 'nothing to do'
                : `move the route${early.length === 1 ? '' : 's'} on line${early.length === 1 ? '' : 's'} ${early.join(', ')} below the guard, or move your body parser above them`,
            },
          ]
        : []),
    ],
  };
}
