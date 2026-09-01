import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveRules } from '../../src/protect/rules/source.js';

/**
 * Where the rules in force came from.
 *
 * This is the fact detection reporting is gated on: security events are collected for sites the platform
 * manages, so a guard must be able to say whether the rules that produced a hit were the platform's.
 * Mislabelling the caller's own bundle as platform-delivered would start collecting retained evidence
 * for a site that never enrolled — and mislabelling the other way would silently collect nothing for one
 * that did.
 *
 * `ok` and `origin` answer different questions and both are asserted: `ok` is whether resolution was
 * clean, `origin` is which leg supplied the rules that are now running. A degraded resolution that fell
 * back to cache is `ok: false` with `origin: 'cache'` — still managed rules.
 */
const BUNDLE = {
  firewall: [{ id: 'r1', title: 't', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'x' } }] }],
  whitelists: [],
};

/** A store that starts empty unless primed, and records what was written. */
function memoryStore(initial: unknown = null) {
  let held: any = initial;

  return {
    read: async () => held,
    write: async (next: any) => { held = next; },
    get held() { return held; },
  };
}

const ok = (body: unknown, etag = '"v1"') =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ETag: etag } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('the origin of the rules in force', () => {
  it('is `api` when the platform delivered them on this call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ ...BUNDLE, enforcement: 'dry-run' })));

    const res: any = await resolveRules({ siteUuid: 's1', pulseRulesUrl: 'https://x.test/p' }, memoryStore());

    expect(res.source).toEqual({ ok: true, origin: 'api' });
  });

  it('is `cache` when the platform revalidated with no change', async () => {
    // 304: the running rules are the platform's, taken from the store rather than the wire.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 304 })));
    const store = memoryStore({ bundle: BUNDLE, etag: '"v1"' });

    const res: any = await resolveRules({ siteUuid: 's1', pulseRulesUrl: 'https://x.test/p' }, store);

    expect(res.source).toEqual({ ok: true, origin: 'cache' });
  });

  it('is `cache` when the fetch failed and last-known-good applied', async () => {
    // Degraded, and still managed. Reporting stays on for exactly these sites: their evidence is the
    // most worth having.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable'); }));
    const store = memoryStore({ bundle: BUNDLE, etag: '"v1"' });

    const res: any = await resolveRules(
      { siteUuid: 's1', pulseRulesUrl: 'https://x.test/p', onError: () => {} },
      store,
    );

    expect(res.source.origin).toBe('cache');
    expect(res.source.ok, 'a fallback is not a clean resolution').toBe(false);
  });

  it('is `bundled` when the fetch failed and the caller supplied its own rules', async () => {
    // The platform never saw these rules, so it has no document to attribute a detection to.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable'); }));

    const res: any = await resolveRules(
      { siteUuid: 's1', pulseRulesUrl: 'https://x.test/p', rules: BUNDLE, onError: () => {} },
      memoryStore(),
    );

    expect(res.source.origin).toBe('bundled');
  });

  it('is `bundled` when no live source is configured at all', async () => {
    // A local install running its own rules: the common unenrolled shape.
    const res: any = await resolveRules({ rules: BUNDLE }, memoryStore());

    expect(res.source).toEqual({ ok: true, origin: 'bundled' });
  });

  it('is `empty` when there is nothing anywhere', async () => {
    const res: any = await resolveRules({}, memoryStore());

    expect(res.source).toEqual({ ok: true, origin: 'empty' });
    expect(res.firewall).toEqual([]);
  });

  it('is `empty` when the fetch failed with no cache and no bundle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable'); }));

    const res: any = await resolveRules(
      { siteUuid: 's1', pulseRulesUrl: 'https://x.test/p', onError: () => {} },
      memoryStore(),
    );

    expect(res.source.origin).toBe('empty');
    expect(res.source.ok).toBe(false);
  });

  it('never reports an origin the reporting gate does not know', async () => {
    // The gate treats `api` and `cache` as managed and everything else as not. An origin outside the set
    // would fall to "not managed" and silently disable reporting for a managed site.
    const known = new Set(['api', 'cache', 'bundled', 'empty']);
    vi.stubGlobal('fetch', vi.fn(async () => ok(BUNDLE)));

    for (const options of [
      {},
      { rules: BUNDLE },
      { siteUuid: 's1', pulseRulesUrl: 'https://x.test/p' },
      { siteUuid: 's1', pulseRulesUrl: 'https://x.test/p', rules: BUNDLE },
    ]) {
      const res: any = await resolveRules(options, memoryStore());

      expect(known, `origin was ${res.source?.origin}`).toContain(res.source?.origin);
    }
  });
});
