import { readFileSync } from 'node:fs';

import { findRulesFile } from './build-stamp.js';
import { writeProjectFileSync } from './safe-file.js';

/** Starter signatures shipped with every guard. They stay in the file whatever the site's rules are. */
const STARTER_PREFIX = 'ps-fallback-';

const COMMENT =
  "Patchstack rules for this site, refreshed from the project's workspace. A running guard that can fetch " +
  'live rules uses those instead; one that cannot — a published app without the key — runs these.';

export type BundledRulesResult = 'written' | 'unchanged' | 'skipped';

/**
 * Put a site's current rules into the guard's own rules file, so a build made without the key ships them.
 *
 * The starter signatures already in the file are kept, the site's rules replace everything else, and any
 * other key (the map identity among them) is left as it is. Nothing is written when nothing changed.
 */
export function writeBundledRules(cwd: string, live: { firewall?: unknown; whitelists?: unknown; whitelist_keys?: unknown; enforcement?: unknown }): BundledRulesResult {
  const location = findRulesFile(cwd);
  if (location.kind !== 'one') return 'skipped';

  let raw: string;
  let current: Record<string, unknown>;
  try {
    raw = readFileSync(location.path, 'utf8');
    current = JSON.parse(raw) as Record<string, unknown>;
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

  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (text === raw) return 'unchanged';
  writeProjectFileSync(cwd, location.path, text, { encoding: 'utf8' });

  return 'written';
}
