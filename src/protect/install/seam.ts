// Shared "seam-file is the guard" wiring, used by adapters whose framework has a single server hook
// that IS the guard (SvelteKit `hooks.server.ts`, Astro `src/middleware.ts`). Scaffold the seam from
// a template + co-locate patchstack.rules.json. An EXISTING seam file is never clobbered — we scaffold
// the rules and print a plan instead (so a hand-written hook is preserved).

import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { read, log, templatesDir } from './util.js';
import type { WireOptions, WireResult, VerifyResult } from './types.js';

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
  mkdirSync(dirname(join(cwd, seamRel)), { recursive: true });

  // Rules co-locate next to the seam (the templates import ./patchstack.rules.json).
  const rulesDst = join(cwd, rulesRel(seamRel));
  const changed: string[] = [];
  if (opts.demo || !existsSync(rulesDst)) {
    copyFileSync(join(templates, opts.demo ? 'demo-rules.json' : 'rules.json'), rulesDst);
    changed.push(rulesRel(seamRel));
  }

  const current = existing ? read(join(cwd, existing)) : '';
  if (existing && !current.includes(spec.marker)) {
    log(`existing ${existing} left untouched — scaffolded ${rulesRel(seamRel)}; ${spec.planHint}`);
    return { ok: true, changed };
  }

  copyFileSync(join(templates, spec.templateName), join(cwd, seamRel));
  changed.push(seamRel);
  log(existing ? `refreshed ${seamRel}` : `scaffolded ${seamRel}`);
  return { ok: true, changed: [...new Set(changed)] };
}

export function verifySeam(cwd: string, spec: SeamSpec): VerifyResult {
  const existing = spec.candidates.find((c) => existsSync(join(cwd, c)));
  const seamRel = existing ?? spec.target;
  const present = existing ? read(join(cwd, existing)).includes(spec.marker) : false;
  const rulesPresent = existsSync(join(cwd, rulesRel(seamRel)));
  return {
    wired: present && rulesPresent,
    checks: [
      { label: `${spec.seamLabel} present`, ok: present, hint: `run \`patchstack-connect protect\` (writes ${spec.target})` },
      { label: 'rules co-located with the guard', ok: rulesPresent, hint: 'run `patchstack-connect protect`' },
    ],
  };
}
