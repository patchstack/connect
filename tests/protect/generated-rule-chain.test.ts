import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * The COORDINATE-PINNED rule chain: a rule generated from an app's own attack-surface map, served by
 * Pulse, and enforced through the HTTP guard.
 *
 * Why this exists as its own file. The defect it guards against was not a broken matcher — it was a
 * composition: a rule bound to the right parameter, scoped to the right route, carrying the right
 * per-rule enforcement, arriving at the runtime intact, and never firing. Every part was individually
 * correct and every unit test passed. `pulse-chain.test.ts` covers the same transport with a STATIC
 * lodash rule whose conditions read `raw`, so it cannot see a failure in the pinned shape: different
 * parameter sources, a route scope, and a match type that was only ever exercised on the egress path.
 *
 * What broke, concretely: `internal_host` classified its value as a hostname, which is what the egress
 * phase hands it. In an application parameter the value is a full URL, so the rule matched nothing for
 * every request-phase SSRF rule the platform could generate. It was found by firing an exploit at a
 * served rule, not by a test — hence this file.
 *
 * The four assertions are the ones that distinguish "protecting" from "present":
 *   detected in dry-run · 403 once promoted · external URL allowed · internal URL on another route allowed.
 */
const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'generated-pinned-rule.json'), 'utf8'),
);

/** The rule exactly as the platform serves it — route scope inside `rule_v2`, enforcement `dry-run`. */
const servedRule = FIXTURE.served;

/**
 * The same coverage with the scope expressed as `when`, the other form the engine supports.
 *
 * The key is `path`, not `route` — worth stating, because writing `route` here is not an error: the scope
 * is simply ignored and the rule applies to every request. That is how the first draft of this test
 * passed on the exploit and then also detected on a route it was scoped away from.
 */
const whenScopedRule = {
  id: 'pulse-1-when',
  title: servedRule.title,
  when: { path: '/api/preview' },
  enforcement: 'dry-run',
  rule_v2: [servedRule.rule_v2[1]],
};

/** A scope nobody can honour: the key is not one the engine knows, so the rule is unscoped. */
const misspelledScopeRule = {
  id: 'pulse-1-misspelled-scope',
  title: servedRule.title,
  when: { route: '/api/preview' },
  enforcement: 'dry-run',
  rule_v2: [servedRule.rule_v2[1]],
};

/** The template before binding. Must be inert: `<param>` is not a parameter source. */
const unboundTemplate = { id: 'pulse-1-unbound', title: servedRule.title, rule_v2: FIXTURE.template.rule_v2 };

/**
 * A mock Pulse endpoint whose per-rule enforcement can be flipped, which is how promotion reaches a
 * running guard. The site stays in `block` throughout: the point is that a generated rule's own
 * `dry-run` overrides it until promotion, so a site-wide mode change cannot promote a rule by accident.
 */
function mockPulse(rule: Record<string, unknown>) {
  const state = { enforcement: 'dry-run', etag: '"v1"' };
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const inm = (init?.headers as Record<string, string> | undefined)?.['If-None-Match'];
    if (inm === state.etag) return new Response(null, { status: 304, headers: { ETag: state.etag } });
    return new Response(
      JSON.stringify({
        firewall: [{ ...rule, enforcement: state.enforcement }],
        whitelists: [],
        whitelist_keys: {},
        enforcement: 'block',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', ETag: state.etag } },
    );
  });
  return { state, fetchMock };
}

const req = (url: string) => new Request(url, { method: 'GET' });
const appHandler = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

/** The exploit: an internal metadata address in the parameter the map proved reaches the HTTP client. */
const SSRF = 'https://app.demo/api/preview?url=http://169.254.169.254/latest/meta-data/';
/** The same route, a legitimate third-party destination. */
const THIRD_PARTY = 'https://app.demo/api/preview?url=https://api.stripe.example/v1/charges';
/** An internal destination on a route this rule is NOT scoped to. */
const OTHER_ROUTE = 'https://app.demo/api/orders?url=http://169.254.169.254/';

describe('generated coordinate-pinned rule, through Pulse and the HTTP guard', () => {
  const prevMode = process.env.PATCHSTACK_MODE;
  afterEach(() => {
    if (prevMode === undefined) delete process.env.PATCHSTACK_MODE;
    else process.env.PATCHSTACK_MODE = prevMode;
    vi.restoreAllMocks();
  });

  it.each([
    ['as the platform serves it (route scoped in rule_v2)', servedRule],
    ['with the scope expressed as when.path', whenScopedRule],
  ])('detects in dry-run and blocks once promoted — %s', async (_label, rule) => {
    delete process.env.PATCHSTACK_MODE;
    const { state, fetchMock } = mockPulse(rule as Record<string, unknown>);
    vi.stubGlobal('fetch', fetchMock);
    const detections: Array<{ rule?: { id?: string } }> = [];

    const p = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      onDetect: (d: { rule?: { id?: string } }) => detections.push(d),
    });

    // The site is in block mode, and the rule is not. A generated rule that inherited the site's mode
    // would start blocking traffic on evidence that has not been corroborated against the running build.
    expect(p.mode).toBe('block');

    // 1. DETECTED, not blocked. This is the assertion the whole file exists for: the composition fires.
    const dry = await p.fetch(appHandler)(req(SSRF));
    expect(dry.status).toBe(200);
    expect(detections.some((d) => d.rule?.id === (rule as { id: string }).id), 'the pinned rule must fire').toBe(true);

    // 2. A legitimate destination on the same route is untouched — the rule screens the DESTINATION, and a
    //    rule that blocked this would be withdrawn before it ever reached a customer.
    expect((await p.fetch(appHandler)(req(THIRD_PARTY))).status).toBe(200);
    expect(detections.length, 'a third-party destination must not detect').toBe(1);

    // 3. The route scope holds: same exploit, different route, no detection at all.
    expect((await p.fetch(appHandler)(req(OTHER_ROUTE))).status).toBe(200);
    expect(detections.length, 'the route scope must exclude other endpoints').toBe(1);

    // 4. Promotion — the platform flips this rule's own enforcement, the guard picks it up on refresh.
    state.enforcement = 'block';
    state.etag = '"v2"';
    await p.refresh();

    expect((await p.fetch(appHandler)(req(SSRF))).status).toBe(403);
    // Still no false positive after promotion, which is the state that actually reaches traffic.
    expect((await p.fetch(appHandler)(req(THIRD_PARTY))).status).toBe(200);
    expect((await p.fetch(appHandler)(req(OTHER_ROUTE))).status).toBe(200);

    p.stopRefresh?.();
  });

  it('warns, and applies everywhere, when a scope names no key the engine knows', async () => {
    // Not hypothetical: this is the shape the first draft of this test used. `when: { route }` is silently
    // unscoped — the rule then applies to every request, which for a promoted rule is a false-positive
    // surface across the whole app rather than one endpoint. Fail-open is right for a scope that cannot be
    // EVALUATED; a scope that cannot be UNDERSTOOD is an authoring mistake, so the engine now says so once.
    delete process.env.PATCHSTACK_MODE;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchMock } = mockPulse(misspelledScopeRule);
    vi.stubGlobal('fetch', fetchMock);
    const detections: unknown[] = [];

    const p = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      onDetect: (d: unknown) => detections.push(d),
    });

    // The route it was meant to be scoped to, and one it was not: both detect.
    await p.fetch(appHandler)(req(SSRF));
    await p.fetch(appHandler)(req(OTHER_ROUTE));
    expect(detections.length, 'an unrecognised scope key leaves the rule unscoped').toBe(2);

    expect(warn.mock.calls.flat().join(' ')).toMatch(/scope|when/i);

    p.stopRefresh?.();
  });

  it('is inert if the template reaches the app with its placeholders unbound', async () => {
    // The other half of the same failure. `<param>` is not a parameter source, so an unbound template
    // loads, reports as a shipped rule, and can never match — and the only way to tell it apart from a
    // working rule is to fire an exploit at it. Asserted so that "generation bound the coordinates" is a
    // property of the chain rather than an assumption about it.
    delete process.env.PATCHSTACK_MODE;
    const { state, fetchMock } = mockPulse(unboundTemplate);
    vi.stubGlobal('fetch', fetchMock);
    const detections: unknown[] = [];

    const p = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      onDetect: (d: unknown) => detections.push(d),
    });

    state.enforcement = 'block';
    state.etag = '"v2"';
    await p.refresh();

    expect((await p.fetch(appHandler)(req(SSRF))).status).toBe(200);
    expect(detections.length, 'an unbound template cannot match anything').toBe(0);

    p.stopRefresh?.();
  });

  it('binds the fixture from a real serve, with no placeholder left in it', () => {
    // Guards the fixture itself: if someone regenerates it from a template rather than from a served
    // response, every assertion above would still pass while testing the wrong shape.
    const json = JSON.stringify(servedRule);
    expect(json).not.toMatch(/<param>|<route>/);
    expect(json).toContain('get.url');
    expect(json).toContain('/api/preview');
    expect(servedRule.enforcement).toBe('dry-run');
    // And the template half must still carry them, or the inertness test above proves nothing.
    expect(JSON.stringify(FIXTURE.template)).toMatch(/<param>/);
  });
});
