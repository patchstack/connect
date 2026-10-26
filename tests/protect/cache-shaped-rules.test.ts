import { describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// A guard handed a copy of its runtime cache entry, rather than a rules file, still runs those rules.
describe('rules passed in the runtime cache shape', () => {
  it('are read as the bundle they hold', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const protection: any = await createProtection({
      mode: 'block',
      reportDetections: false,
      rules: {
        bundle: {
          firewall: [{ id: 'cached-traversal', rule_v2: [{ parameter: 'get.f', mutations: ['urldecode'], match: { type: 'contains', value: '../' } }] }],
          whitelists: [], whitelist_keys: {}, enforcement: 'block',
        },
        etag: 'W/"1"', buildId: null, source: 'site:x@',
      } as never,
    });
    try {
      const blocked = await protection.fetchGuard()(new Request('https://app.test/?f=../../etc/passwd'));
      expect(blocked?.status).toBe(403);
      expect(await protection.fetchGuard()(new Request('https://app.test/'))).toBeNull();
    } finally {
      await protection.stop();
      vi.restoreAllMocks();
    }
  });
});
