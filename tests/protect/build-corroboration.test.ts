// A build-scoped rule may only enforce for the mapped coordinates it belongs to — and only when
// the platform says so.
//
// A scoped rule addresses a route and a field name read out of one build's source. A rename two deploys
// later leaves it addressing nothing while still reporting as protection. So enforcement needs an answer
// to "does this guard carry the map those coordinates came from", and the client cannot answer it: it
// can only present the map identity it carries. The platform answers, and its answer is what these tests are about.
//
// The three failures either side of that:
//   - an ordinary rule losing enforcement because a build identity was unavailable;
//   - a scoped rule enforcing because the guard PRESENTED an identity and nothing contradicted it;
//   - a scoped rule regaining enforcement from a cache, an ETag, or a locally supplied bundle.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection, createServerFnGuard } from '../../src/protect/runtime.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

/** Scoped: its coordinate belongs to map A. */
const SCOPED = {
  id: 'pulse-1',
  build_scope: A,
  source_revision: 7,
  rule_v2: [{ parameter: 'post.title', match: { type: 'inline_xss' } }],
};
/**
 * Ordinary, and carrying a `source_revision` on purpose.
 *
 * That field is the revision of any served rule document — a hash for a curated rule, a number for a
 * generated one — and reading it as a scoping marker would hold rules like this one in dry-run, losing
 * protection that never depended on a coordinate.
 */
const ORDINARY = {
  id: 'rm-npm-0001',
  source_revision: 'sha256:abcdef',
  rule_v2: [{ parameter: 'post.body', match: { type: 'inline_xss' } }],
};

const bundle = (firewall: unknown[]) => ({ firewall, whitelists: [], whitelist_keys: {} });
const PAYLOAD = bundle([SCOPED, ORDINARY]);

const XSS = '<img src=x onerror="steal()">';
const URL_OPT = 'https://x.test/monitor/pulse';
const CREDENTIAL = 'the-secret-40-chars-long-ish-value-here-987';

const blockedBy = async (p: any, field: 'title' | 'body') =>
  (await createServerFnGuard({ protection: p })({ [field]: XSS }))?.rule;

/** Rules carrying a stamp, as a scaffolded guard's bundled file would after a build. */
const stamped = (id: string | null) => ({
  ...bundle([]),
  ...(id === null ? {} : { _patchstack: { build_id: id } }),
});

const sentBuild = (init: any) => init?.headers?.['X-Patchstack-Build'] ?? null;
const ifNoneMatch = (init: any) => init?.headers?.['If-None-Match'] ?? null;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

const cacheDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-corroborate-'));
  dirs.push(dir);

  return dir;
};

/**
 * Serve the token exchange and the rule bundle, with whatever verdict the case is about.
 *
 * `verdict` undefined models a platform that has never heard of any of this — the state every server is
 * in until the endpoint implements it, and the one that must not read as corroboration.
 */
function serve(verdict?: { build_match?: string; build_id?: string }, etag = 'v1') {
  const seen: { build: string | null; etag: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any) => {
      if (String(url).includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
      }
      seen.push({ build: sentBuild(init), etag: ifNoneMatch(init) });
      const headers = new Headers({ etag });
      if (verdict?.build_match !== undefined) headers.set('X-Patchstack-Build-Match', verdict.build_match);
      if (verdict?.build_id !== undefined) headers.set('X-Patchstack-Build-ID', verdict.build_id);
      if (ifNoneMatch(init) === etag) return new Response(null, { status: 304, headers });

      return new Response(JSON.stringify(PAYLOAD), { status: 200, headers });
    }),
  );

  return seen;
}

const envelope = (dir: string) => JSON.parse(readFileSync(join(dir, 'patchstack-rules.json'), 'utf8'));

const guard = (dir: string, extra: Record<string, unknown> = {}) =>
  createProtection({ siteUuid: 's', pulseAuth: CREDENTIAL, pulseRulesUrl: URL_OPT, cacheDir: dir, mode: 'block', ...extra });

const MATCH = { build_match: 'match', build_id: A };

describe('what the platform confirms', () => {
  it('lets a scoped rule block when the platform confirms this map', async () => {
    const dir = cacheDir();
    const seen = serve(MATCH);
    const p = await guard(dir, { rules: stamped(A) });

    expect(await blockedBy(p, 'title')).toBe('pulse-1');
    expect(seen[0]!.build, 'the map is presented on the request').toBe(A);
    // The VERDICT is cached, not the claim. `buildId` is what was presented; `matchedBuildId` is what
    // the platform confirmed, and only the second licenses anything.
    expect(envelope(dir)).toMatchObject({ buildId: A, matchedBuildId: A });
  });

  it.each([
    ['no verdict at all — a platform that has never heard of this', undefined],
    ['an unknown verdict word', { build_match: 'maybe', build_id: A }],
    ['missing', { build_match: 'missing' }],
    ['mismatch', { build_match: 'mismatch', build_id: B }],
    ['a bare match naming nothing', { build_match: 'match' }],
    ['a match naming a different map', { build_match: 'match', build_id: B }],
  ])('holds a scoped rule in dry-run given %s', async (_label, verdict) => {
    // The heart of it. Presenting an identity is not corroboration, so anything short of an explicit
    // confirmation naming THIS map leaves the rule detecting.
    const dir = cacheDir();
    const notices: string[] = [];
    serve(verdict as any);
    const p = await guard(dir, { rules: stamped(A), onError: (e: unknown) => notices.push(String((e as Error).message)) });

    expect(await blockedBy(p, 'title')).toBeUndefined();
    expect(notices.join(' ')).toMatch(/build-scoped rule\(s\) are detecting only/);
    expect(envelope(dir).matchedBuildId ?? null, 'nothing may be recorded as confirmed').toBeNull();
  });

  it('keeps enforcing ordinary rules, including versioned ones', async () => {
    // `ORDINARY` carries a `source_revision`, which is document metadata and not a coordinate. Losing
    // its enforcement because a build identity was unavailable would trade away protection that never
    // depended on one.
    serve();
    const p = await guard(cacheDir(), { rules: stamped(A) });

    expect(await blockedBy(p, 'body')).toBe('rm-npm-0001');
  });

  it('sends no identity at all when it has none, rather than a placeholder', async () => {
    const seen = serve();
    await guard(cacheDir(), { rules: stamped(null) });

    expect(seen[0]!.build).toBeNull();
  });

  it('never takes an identity or a verdict from the response body alone', async () => {
    // A response asserting it is map B, in every shape a stamp or verdict is written in.
    const dir = cacheDir();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/token')) {
          return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
        }

        return new Response(
          JSON.stringify({ ...PAYLOAD, build_match: 'match', build_id: B, _patchstack: { build_id: B } }),
          { status: 200 },
        );
      }),
    );
    const p = await guard(dir, { rules: stamped(A) });

    expect(await blockedBy(p, 'title'), 'a match naming B does not confirm A').toBeUndefined();
    expect(envelope(dir)).toMatchObject({ buildId: A, matchedBuildId: null });
  });
});

describe('the cache', () => {
  it('carries a confirmation forward through a 304, for the same map', async () => {
    const dir = cacheDir();
    serve(MATCH);
    expect(await blockedBy(await guard(dir, { rules: stamped(A) }), 'title')).toBe('pulse-1');

    const seen = serve(MATCH);
    const second = await guard(dir, { rules: stamped(A) });
    expect(seen[0]!.etag, 'the same map may revalidate').toBe('v1');
    expect(await blockedBy(second, 'title'), 'the confirmation it already had still stands').toBe('pulse-1');
  });

  it('revokes a cached confirmation when a 304 reports that the recorded map moved', async () => {
    const dir = cacheDir();
    serve(MATCH);
    expect(await blockedBy(await guard(dir, { rules: stamped(A) }), 'title')).toBe('pulse-1');

    const seen = serve({ build_match: 'mismatch' });
    const second = await guard(dir, { rules: stamped(A) });

    expect(seen[0]!.etag, 'the rule bundle itself is unchanged').toBe('v1');
    expect(await blockedBy(second, 'title')).toBeUndefined();
    expect(envelope(dir)).toMatchObject({ buildId: A, matchedBuildId: null });
  });

  it('can receive its first confirmation while revalidating an unchanged bundle', async () => {
    const dir = cacheDir();
    serve({ build_match: 'missing' });
    expect(await blockedBy(await guard(dir, { rules: stamped(A) }), 'title')).toBeUndefined();

    const seen = serve(MATCH);
    const second = await guard(dir, { rules: stamped(A) });

    expect(seen[0]!.etag).toBe('v1');
    expect(await blockedBy(second, 'title')).toBe('pulse-1');
  });

  it('does not lend a confirmation to a different map', async () => {
    const dir = cacheDir();
    serve(MATCH);
    await guard(dir, { rules: stamped(A) });

    // Now map B reads A's cache. Its ETag must not be reused either: a 304 would hand A's bundle
    // back as current, which is how a coordinate from the previous build becomes enforceable again.
    const seen = serve({ build_match: 'match', build_id: B });
    const second = await guard(dir, { rules: stamped(B) });

    expect(seen[0]!.etag).toBeNull();
    expect(seen[0]!.build).toBe(B);
    // B's own rules are served, and SCOPED names A, so it stays detecting even though B was confirmed.
    expect(await blockedBy(second, 'title')).toBeUndefined();
  });

  it('does not treat a cache written before verdicts existed as confirmed', async () => {
    const dir = cacheDir();
    serve(MATCH);
    await guard(dir, { rules: stamped(A) });

    // Rewrite the envelope as an older client would have left it: the identity present, no verdict.
    const stored = envelope(dir);
    delete stored.matchedBuildId;
    (await import('node:fs')).writeFileSync(join(dir, 'patchstack-rules.json'), JSON.stringify(stored));

    serve(); // the platform still says nothing
    expect(await blockedBy(await guard(dir, { rules: stamped(A) }), 'title')).toBeUndefined();
  });

  it('does not accept a crossed cache envelope as confirmation', async () => {
    const crossed = {
      bundle: PAYLOAD,
      etag: 'v1',
      buildId: B,
      matchedBuildId: A,
    };
    const ruleCache = { read: () => crossed, write: vi.fn() };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    const p = await createProtection({
      siteUuid: 's',
      pulseAuth: CREDENTIAL,
      pulseRulesUrl: URL_OPT,
      rules: stamped(A),
      ruleCache,
      mode: 'block',
    });

    expect(await blockedBy(p, 'title')).toBeUndefined();
    expect(await blockedBy(p, 'body')).toBe('rm-npm-0001');
  });

  it('falls back to a cache on failure without lending it enforcement', async () => {
    const dir = cacheDir();
    serve(MATCH);
    await guard(dir, { rules: stamped(A) });

    const notices: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const p = await guard(dir, { rules: stamped(B), onError: (e: unknown) => notices.push(String((e as Error).message)) });

    expect(await blockedBy(p, 'body'), 'the cached ordinary rule still protects').toBe('rm-npm-0001');
    expect(await blockedBy(p, 'title'), 'A’s confirmation is not B’s').toBeUndefined();
  });

  it('lets two unidentified runs revalidate, and confirms neither', async () => {
    // Revalidation and corroboration are different questions. Withholding revalidation from every guard
    // built before stamping existed would cost a full download per refresh and change nothing about
    // what may enforce.
    const dir = cacheDir();
    serve();
    await guard(dir, { rules: stamped(null) });

    const seen = serve();
    const second = await guard(dir, { rules: stamped(null) });
    expect(seen[0]!.etag).toBe('v1');
    expect(await blockedBy(second, 'title')).toBeUndefined();
    expect(await blockedBy(second, 'body')).toBe('rm-npm-0001');
  });
});

describe('the token-authenticated rules source', () => {
  it('keeps scoped rules detect-only through a live response, 304 and cached fallback', async () => {
    const dir = cacheDir();
    const notices: string[] = [];
    const options = {
      token: 'token',
      baseUrl: 'https://x.test',
      cacheDir: dir,
      mode: 'block' as const,
      onError: (error: unknown) => notices.push(String((error as Error).message)),
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(bundle([SCOPED, ORDINARY])), {
          status: 200,
          headers: { etag: 'v1' },
        }),
      ),
    );
    const live = await createProtection(options);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 304, headers: { etag: 'v1' } })));
    const revalidated = await createProtection(options);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));
    const cached = await createProtection(options);

    for (const protection of [live, revalidated, cached]) {
      expect(await blockedBy(protection, 'title')).toBeUndefined();
      expect(await blockedBy(protection, 'body')).toBe('rm-npm-0001');
    }
    expect(notices.join(' ')).toMatch(/token-authenticated rules service did not corroborate/);
  });
});

describe('rules the caller supplied', () => {
  it('holds a scoped rule in dry-run by default, whatever its provenance', async () => {
    // Supplying a rule locally establishes intent, not freshness: a vendored bundle can hold a generated
    // coordinate from an older map exactly as a served one can.
    const p = await createProtection({ rules: bundle([SCOPED, ORDINARY]), mode: 'block' });

    expect(await blockedBy(p, 'title')).toBeUndefined();
    expect(await blockedBy(p, 'body')).toBe('rm-npm-0001');
  });

  it('enforces a scoped rule that names this very map', async () => {
    // The caller supplied both halves — the rule's target and the guard's identity — and they agree.
    const p = await createProtection({ rules: bundle([SCOPED]), buildId: A, mode: 'block' });

    expect(await blockedBy(p, 'title')).toBe('pulse-1');
  });

  it('does not enforce a scoped rule naming a different map', async () => {
    const p = await createProtection({ rules: bundle([SCOPED]), buildId: B, mode: 'block' });

    expect(await blockedBy(p, 'title')).toBeUndefined();
  });

  it('enforces when the caller explicitly takes responsibility', async () => {
    // The named opt-in, for a caller that knows the rules match the running source — a test vendoring a
    // rule against a fixed fixture, or a build that generates both together.
    const p = await createProtection({ rules: bundle([SCOPED]), trustLocalRuleScope: true, mode: 'block' });

    expect(await blockedBy(p, 'title')).toBe('pulse-1');
  });

  it('applies the same rule to a bundled fallback reached because the platform was unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const held = await guard(cacheDir(), { rules: bundle([SCOPED]) });
    expect(await blockedBy(held, 'title')).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const trusted = await guard(cacheDir(), { rules: bundle([SCOPED]), trustLocalRuleScope: true });
    expect(await blockedBy(trusted, 'title')).toBe('pulse-1');
  });
});

describe('a malformed scope', () => {
  it.each([
    ['null', null],
    ['undefined on a present property', undefined],
    ['a number', 7],
    ['an object', { id: A }],
    ['an abbreviated id', 'deadbee'],
  ])('keeps %s accepted but scoped and unmatchable', async (_label, scope) => {
    // A value nothing can compare is not permission. Reading it as "no scope" would let it enforce.
    const rejected: unknown[] = [];
    const notices: string[] = [];
    const p = await createProtection({
      rules: bundle([{ ...SCOPED, build_scope: scope }]),
      buildId: A,
      mode: 'block',
      onRuleRejected: (rule: unknown) => rejected.push(rule),
      onError: (error: unknown) => notices.push(String((error as Error).message)),
    });

    expect(await blockedBy(p, 'title')).toBeUndefined();
    expect(rejected).toEqual([]);
    expect(notices.join(' ')).toMatch(/unusable build_scope/);
  });

  it('can enforce only when the local caller explicitly takes responsibility', async () => {
    const p = await createProtection({
      rules: bundle([{ ...SCOPED, build_scope: null }]),
      trustLocalRuleScope: true,
      mode: 'block',
    });

    expect(await blockedBy(p, 'title')).toBe('pulse-1');
  });
});

describe('whitelists', () => {
  it('refuses build_scope instead of letting an unconfirmed coordinate suppress protection', async () => {
    const rejected: any[] = [];
    const p = await createProtection({
      rules: {
        ...bundle([ORDINARY]),
        whitelists: [
          {
            id: 'wl-1',
            rule_id: ORDINARY.id,
            build_scope: B,
            rule_v2: [{ parameter: 'post.body', match: { type: 'inline_xss' } }],
          },
        ],
      },
      buildId: A,
      mode: 'block',
      onRuleRejected: (rule: any) => rejected.push(rule),
    });

    expect(await blockedBy(p, 'body')).toBe('rm-npm-0001');
    expect(rejected).toEqual([
      expect.objectContaining({ id: 'wl-1', reason: expect.stringMatching(/build_scope/) }),
    ]);
  });
});
