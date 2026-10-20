import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { writeBundledRules } from '../src/bundled-rules.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A project with a scaffolded guard that imports its co-located rules file. */
function project(rules: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-bundled-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'src/patchstack'), { recursive: true });
  writeFileSync(join(dir, 'src/patchstack/guard.ts'), "import rules from './rules.json';\nimport { protectFetch } from '@patchstack/connect/protect';\nexport { rules, protectFetch };\n");
  writeFileSync(join(dir, 'src/patchstack/rules.json'), `${JSON.stringify(rules, null, 2)}\n`);
  return dir;
}

const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'src/patchstack/rules.json'), 'utf8'));
const starter = { id: 'ps-fallback-proto-pollution', title: 'starter' };
const stamp = { build_id: 'a'.repeat(64) };

describe('writeBundledRules', () => {
  it("keeps the starter signatures and the map identity, and replaces everything else with the site's rules", () => {
    const dir = project({ _comment: 'old', _patchstack: stamp, firewall: [starter, { id: 'stale' }], whitelists: [], whitelist_keys: {} });

    expect(writeBundledRules(dir, { firewall: [{ id: 'site-1' }, { id: 'site-2' }], whitelists: [], whitelist_keys: {}, enforcement: 'block' })).toBe('written');

    const written = read(dir);
    expect(written.firewall.map((rule: { id: string }) => rule.id)).toEqual(['ps-fallback-proto-pollution', 'site-1', 'site-2']);
    expect(written._patchstack).toEqual(stamp);
    expect(written.enforcement).toBe('block');
  });

  it('writes nothing when the rules have not changed', () => {
    const dir = project({ firewall: [starter], whitelists: [], whitelist_keys: {} });
    const live = { firewall: [{ id: 'site-1' }], whitelists: [], whitelist_keys: {} };

    expect(writeBundledRules(dir, live)).toBe('written');
    expect(writeBundledRules(dir, live)).toBe('unchanged');
  });

  it('lets a delivered rule replace a starter signature with the same id', () => {
    const dir = project({ firewall: [starter], whitelists: [], whitelist_keys: {} });

    writeBundledRules(dir, { firewall: [{ id: 'ps-fallback-proto-pollution', title: 'delivered' }] });

    expect(read(dir).firewall).toEqual([{ id: 'ps-fallback-proto-pollution', title: 'delivered' }]);
  });

  it('stores the rules reader beside the map identity, and keeps it when a later run has none', () => {
    const dir = project({ _patchstack: stamp, firewall: [starter], whitelists: [], whitelist_keys: {} });
    const reader = `rr_${'b'.repeat(48)}-7`;

    writeBundledRules(dir, { firewall: [{ id: 'site-1' }] }, reader);
    expect(read(dir)._patchstack).toEqual({ ...stamp, rules_reader: reader });

    writeBundledRules(dir, { firewall: [{ id: 'site-2' }] });
    expect(read(dir)._patchstack.rules_reader).toBe(reader);
  });

  it('touches nothing in a project with no guard rules file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-bundled-none-'));
    dirs.push(dir);

    expect(writeBundledRules(dir, { firewall: [{ id: 'site-1' }] })).toBe('skipped');
  });
});
