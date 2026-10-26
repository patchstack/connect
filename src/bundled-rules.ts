import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findRulesFile, ruleBundleOf } from './build-stamp.js';
import { writeProjectFileSync } from './safe-file.js';

/** Starter signatures shipped with every guard. They stay in the file whatever the site's rules are. */
const STARTER_PREFIX = 'ps-fallback-';

const COMMENT =
  "Patchstack rules for this site, refreshed from the project's workspace, used until the running guard " +
  "fetches live ones. _patchstack.rules_reader is a read-only credential for that fetch: it can read this " +
  "site's rules and nothing else. Server-side only — never import this file into browser code.";

export type BundledRulesResult = 'written' | 'unchanged' | 'skipped';

/**
 * Whether this project keeps its guard's rules file current: it has a guard rules file, and has not
 * turned it off with `"bundleRules": false` in .patchstackrc.json.
 *
 * Decided from the project, not from which builder made it, so any builder that publishes from the
 * project files ships current rules and the read-only rules credential with its app.
 */
export function bundleRulesAllowed(cwd: string): boolean {
  try {
    const config = JSON.parse(readFileSync(join(cwd, '.patchstackrc.json'), 'utf8')) as { bundleRules?: unknown };
    if (config.bundleRules === false) return false;
  } catch {
    // No readable project config: nothing has turned it off.
  }

  return findRulesFile(cwd).kind === 'one';
}

/**
 * Put a site's current rules into the guard's own rules file, so a build made without the key ships them.
 *
 * The starter signatures already in the file are kept, the site's rules replace everything else, and any
 * other key (the map identity among them) is left as it is. With a rules-reader credential, that is
 * stored too, so the running guard can fetch rules that change after the build. Nothing is written when
 * nothing changed.
 */
export function writeBundledRules(
  cwd: string,
  live: { firewall?: unknown; whitelists?: unknown; whitelist_keys?: unknown; enforcement?: unknown },
  rulesReader: string | null = null,
): BundledRulesResult {
  const location = findRulesFile(cwd);
  if (location.kind !== 'one') return 'skipped';

  let raw: string;
  let current: Record<string, unknown>;
  try {
    raw = readFileSync(location.path, 'utf8');
    // A copied runtime cache entry is read as the bundle it carries, so this write leaves a plain rules file.
    const bundle = ruleBundleOf(JSON.parse(raw));
    if (bundle === null) return 'skipped';
    current = bundle;
  } catch {
    return 'skipped';
  }

  const id = (rule: unknown): string => (rule !== null && typeof rule === 'object' ? String((rule as { id?: unknown }).id ?? '') : '');
  const liveRules = Array.isArray(live.firewall) ? live.firewall : [];
  const liveIds = new Set(liveRules.map(id));
  const starter = (Array.isArray(current.firewall) ? current.firewall : []).filter(
    (rule) => id(rule).startsWith(STARTER_PREFIX) && !liveIds.has(id(rule)),
  );

  const next: Record<string, unknown> = {
    ...current,
    _comment: COMMENT,
    firewall: [...starter, ...liveRules],
    whitelists: Array.isArray(live.whitelists) ? live.whitelists : [],
    whitelist_keys: live.whitelist_keys !== null && typeof live.whitelist_keys === 'object' ? live.whitelist_keys : {},
  };
  if (typeof live.enforcement === 'string') next.enforcement = live.enforcement;
  // The read-only credential a guard without the site credential fetches live rules with. Beside the map
  // identity in the same namespace; a later run without one keeps whatever is there.
  if (rulesReader !== null) {
    const namespace = current._patchstack !== null && typeof current._patchstack === 'object' ? current._patchstack : {};
    next._patchstack = { ...namespace, rules_reader: rulesReader };
  }

  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (text === raw) return 'unchanged';
  writeProjectFileSync(cwd, location.path, text, { encoding: 'utf8' });

  return 'written';
}
