import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProtection } from '../../src/protect/runtime.js';

// Validation must never make a bad update WORSE than no update. Dropping individual bad rules is fine
// for a bundle we already trust, but for a fresh remote response it would let a broken/oversized/
// truncated update replace known-good policy with partial or empty policy — and cache that loss.
// A live update is therefore accepted atomically: all-or-nothing, keep last-known-good, don't cache.

const GOOD = { id: 'good-1', rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '__proto__' } }] };
const BAD = { id: 'bad-1', phase: 'sideways', rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: 'x' } }] };
const bundle = (firewall: any[]) => JSON.stringify({ firewall, whitelists: [], whitelist_keys: {} });

afterEach(() => vi.restoreAllMocks());

describe('atomic live-bundle acceptance', () => {
  it('keeps the cached ruleset and does NOT overwrite the cache when an update fails validation', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'ps-atomic-'));
    try {
      // 1. A good update is accepted and cached.
      vi.stubGlobal('fetch', vi.fn(async () => new Response(bundle([GOOD]), { status: 200, headers: { ETag: '"v1"' } })));
      const p1: any = await createProtection({ siteUuid: 's1', pulseRulesUrl: 'https://x.test/p', cacheDir, mode: 'block' });
      expect(p1.rules.request.map((r: any) => r.id)).toEqual(['good-1']);
      const cachedAfterGood = readFileSync(join(cacheDir, 'patchstack-rules.json'), 'utf8');
      expect(cachedAfterGood).toContain('good-1');

      // 2. A later update contains an invalid rule → reject the WHOLE update.
      const errors: Error[] = [];
      vi.stubGlobal('fetch', vi.fn(async () => new Response(bundle([GOOD, BAD]), { status: 200, headers: { ETag: '"v2"' } })));
      const p2: any = await createProtection({
        siteUuid: 's1', pulseRulesUrl: 'https://x.test/p', cacheDir, mode: 'block',
        onError: (e: Error) => errors.push(e),
      });
      // Still protected by last-known-good, and the cache was NOT replaced.
      expect(p2.rules.request.map((r: any) => r.id)).toEqual(['good-1']);
      expect(readFileSync(join(cacheDir, 'patchstack-rules.json'), 'utf8')).toBe(cachedAfterGood);
      expect(errors.map((e) => e.message).join(' ')).toMatch(/rejected the entire update/i);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('reports each rejected rule and never caches the bad response', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'ps-atomic2-'));
    try {
      const rejected: any[] = [];
      vi.stubGlobal('fetch', vi.fn(async () => new Response(bundle([BAD]), { status: 200 })));
      // No prior cache and no bundled fallback → running with no rules is correct, but nothing is cached.
      const p: any = await createProtection({
        siteUuid: 's1', pulseRulesUrl: 'https://x.test/p', cacheDir, mode: 'block',
        onRuleRejected: (r: any) => rejected.push(r),
      });
      expect(p.rules.request).toEqual([]);
      expect(rejected[0]).toMatchObject({ id: 'bad-1', accepted: false });
      expect(existsSync(join(cacheDir, 'patchstack-rules.json'))).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('falls back to the bundled ruleset rather than an empty policy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bundle([BAD]), { status: 200 })));
    const p: any = await createProtection({
      siteUuid: 's1', pulseRulesUrl: 'https://x.test/p', mode: 'block',
      rules: { firewall: [GOOD], whitelists: [], whitelist_keys: {} } as any,
    });
    expect(p.rules.request.map((r: any) => r.id)).toEqual(['good-1']);
  });

  it('accepts a partial bundle only when explicitly opted in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bundle([GOOD, BAD]), { status: 200 })));
    const p: any = await createProtection({
      siteUuid: 's1', pulseRulesUrl: 'https://x.test/p', mode: 'block', acceptPartialBundle: true,
    });
    expect(p.rules.request.map((r: any) => r.id)).toEqual(['good-1']); // bad one dropped, good kept
  });

  it('rejects a whitelist with no rule_id, which would suppress every rule', async () => {
    const rejected: any[] = [];
    const global = { rule_v2: [{ parameter: 'get.debug', match: { type: 'equals', value: '1' } }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ firewall: [GOOD], whitelists: [global], whitelist_keys: {} }), { status: 200 },
    )));
    const p: any = await createProtection({
      siteUuid: 's1', pulseRulesUrl: 'https://x.test/p', mode: 'block',
      rules: { firewall: [GOOD], whitelists: [], whitelist_keys: {} } as any,
      onRuleRejected: (r: any) => rejected.push(r),
    });
    expect(rejected.some((r) => /no rule_id/.test(r.reason))).toBe(true);
    expect(p.rules.request.map((r: any) => r.id)).toEqual(['good-1']); // fell back, still protected
  });
});
