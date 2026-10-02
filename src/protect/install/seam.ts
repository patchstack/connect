// Shared "seam-file is the guard" wiring, used by adapters whose framework has a single server hook
// that IS the guard (SvelteKit `hooks.server.ts`, Astro `src/middleware.ts`). Scaffold the seam from
// a template + co-locate patchstack.rules.json. An EXISTING seam file is never clobbered — we scaffold
// the rules and print a plan instead (so a hand-written hook is preserved).

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { bakeSiteUuid, read, log, templatesDir } from './util.js';
import type { WireOptions, WireResult, VerifyResult } from './types.js';
import { copyProjectFileSync, ensureProjectDirectorySync } from '../../safe-file.js';
import { parsedSource, sourceCompiler } from './syntax.js';
import { installTemplate } from './template-upgrade.js';

export interface SeamSpec {
  templateName: string; // template copied to the seam target when none exists
  candidates: string[]; // existing seam files to look for, in order (repo-relative)
  target: string; // where to create the seam if none exists (repo-relative)
  marker: string; // #region marker id proving it's ours (e.g. 'patchstack-sveltekit')
  planHint: string; // guidance when an existing seam file can't be safely edited
  seamLabel: string; // human label for the check (e.g. 'SvelteKit hook')
}

function rulesRel(seamRel: string): string {
  const d = dirname(seamRel);
  return (d === '.' ? 'patchstack.rules.json' : `${d}/patchstack.rules.json`).replace(/\\/g, '/');
}

export function wireSeam(cwd: string, opts: WireOptions, spec: SeamSpec): WireResult {
  const templates = templatesDir();
  const existing = spec.candidates.find((c) => existsSync(join(cwd, c)));
  const seamRel = existing ?? spec.target;
  ensureProjectDirectorySync(cwd, dirname(join(cwd, seamRel)));

  // Rules co-locate next to the seam (the templates import ./patchstack.rules.json).
  const rulesDst = join(cwd, rulesRel(seamRel));
  const changed: string[] = [];
  if (opts.demo || !existsSync(rulesDst)) {
    copyProjectFileSync(cwd, join(templates, opts.demo ? 'demo-rules.json' : 'rules.json'), rulesDst);
    changed.push(rulesRel(seamRel));
  }

  const current = existing ? read(join(cwd, existing)) : '';
  if (existing && current.includes(spec.marker)) {
    // Only an unchanged generated file can be upgraded; customized hooks remain user-owned.
    if (installTemplate(cwd, seamRel, spec.templateName)) changed.push(seamRel);
    return { ok: true, changed };
  }
  if (existing) {
    log(`existing ${existing} left untouched — scaffolded ${rulesRel(seamRel)}; ${spec.planHint}`);
    return { ok: true, changed };
  }

  copyProjectFileSync(cwd, join(templates, spec.templateName), join(cwd, seamRel));
  if (!opts.demo) bakeSiteUuid(cwd, seamRel);
  changed.push(seamRel);
  log(`scaffolded ${seamRel}`);
  return { ok: true, changed: [...new Set(changed)] };
}

export function verifySeam(cwd: string, spec: SeamSpec): VerifyResult {
  const existing = spec.candidates.find((c) => existsSync(join(cwd, c)));
  const seamRel = existing ?? spec.target;
  const present = existing ? templateWiringPresent(cwd, existing, spec.templateName) : false;
  const rulesPresent = existsSync(join(cwd, rulesRel(seamRel)));
  return {
    wired: present && rulesPresent,
    checks: [
      { label: `${spec.seamLabel} wiring verified`, ok: present, hint: `run \`patchstack-connect protect\`; customized hooks need manual verification (${spec.target})` },
      { label: 'rules co-located with the guard', ok: rulesPresent, hint: 'run `patchstack-connect protect`' },
    ],
  };
}

/** Compare executable hook statements, not comments or strings that merely name a guard. */
export function templateWiringPresent(cwd: string, file: string, template: string): boolean {
  const ts = sourceCompiler(cwd);
  if (!ts) return false;
  const actual = parsedSource(ts, file, read(join(cwd, file)));
  const expected = parsedSource(ts, template, read(join(templatesDir(), template)));
  if (!actual || !expected) return false;
  const printer = ts.createPrinter({ removeComments: true });
  const emit = (node: import('typescript').Node, tree: import('typescript').SourceFile) => printer.printNode(ts.EmitHint.Unspecified, node, tree);
  const required = expected.statements.filter(node =>
    ts.isExportAssignment(node) || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
    || (ts.isFunctionDeclaration(node) && node.name?.text === 'getProtection')
    || (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@patchstack/connect/protect'));
  const code = actual.statements.map(node => emit(node, actual));
  return required.length >= 3 && required.every(node => code.filter(text => text === emit(node, expected)).length === 1);
}
