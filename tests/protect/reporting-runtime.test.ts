import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * Reporting at the runtime seam: is it on by default for a managed site, does each opt-out reach it, does
 * the platform learn the state, and does it follow a refresh.
 *
 * The state calculator is covered exhaustively elsewhere. What these cover is the wiring — a correct
 * calculator that the runtime never consults, or consults once at boot, produces exactly the failure the
 * state exists to prevent: a managed site that silently never reports, or an unmanaged one that does.
 */
const AUTH = 'the-secret-40-chars-long-ish-value-here-987';
const RULES = {
  firewall: [{ id: 'r1', title: 't', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }] }],
  whitelists: [],
  enforcement: 'dry-run',
};

const drain = async () => { await new Promise((r) => setTimeout(r, 5)); };

/** A fetch stub that serves rules, and records the capability header of every rules request. */
function stubFetch(opts: { rulesOk?: boolean; etag?: string; refuseDetections?: boolean } = {}) {
  const capabilityHeaders: Array<string | undefined> = [];
  const posted: string[] = [];
  const bodies: any[] = [];
  let rulesOk = opts.rulesOk ?? true;

  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    // The credential is exchanged for a short-lived token before the rules fetch. Without answering this,
    // the rules request carries no Authorization — and the capability header only travels on an
    // authenticated request, so every capability assertion would fail for the wrong reason.
    if (target.includes('token')) {
      return new Response(JSON.stringify({ access_token: 'jwt-abc', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (target.includes('/detections/')) {
      posted.push(target);
      bodies.push(JSON.parse(String(init?.body ?? '{}')));

      return new Response('{}', {
        status: opts.refuseDetections ? 503 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    capabilityHeaders.push((init?.headers as Record<string, string>)?.['X-Patchstack-Detections']);
    if (!rulesOk) throw new Error('rules unreachable');

    return new Response(JSON.stringify(RULES), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ETag: opts.etag ?? '"v1"' },
    });
  });

  vi.stubGlobal('fetch', impl);

  return { capabilityHeaders, posted, bodies, setRulesOk: (v: boolean) => { rulesOk = v; } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  // In afterEach, not at the end of a test body: an assertion that fails would otherwise leak a
  // stubbed variable into every test after it.
  vi.unstubAllEnvs();
});

describe('reporting is on by default for a managed site', () => {
  it('needs no config flag', async () => {
    // The behaviour that changed. Nothing here asks for reporting: an enrolled site running rules the
    // platform delivered, with a credential, reports.
    const { posted } = stubFetch();
    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: AUTH,
      detectionFlushMs: 1,
    });

    expect(p.detectionReporting).toBe('on');

    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));
    p.stop();
    await drain();
    await drain();

    expect(posted.length, 'an event reached the endpoint').toBeGreaterThan(0);
  });

  it('sends nothing for a local install running its own rules', async () => {
    // A bare install: no site identity, so nothing to report against and no endpoint to report to.
    const p: any = await createProtection({ rules: RULES, mode: 'dry-run', detectionFlushMs: 1 });

    expect(p.detectionReporting).toBe('not-enrolled');
    expect(p.detectionHealth).toBeUndefined();
    p.stop();
  });

  it('sends nothing for a site identity whose rules are not the platform’s', async () => {
    // Enrolled-looking, but the rules in force are the caller's own, so a detection could not be
    // attributed to a managed rule document.
    const { posted, setRulesOk } = stubFetch();
    setRulesOk(false);
    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: AUTH,
      rules: RULES,
      detectionFlushMs: 1,
      onError: () => {},
    });

    expect(p.detectionReporting).toBe('no-managed-rules');

    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));
    p.stop();
    await drain();

    expect(posted).toEqual([]);
  });
});

describe('each opt-out reaches the runtime', () => {
  it.each([
    ['PATCHSTACK_REPORT_DETECTIONS', 'disabled-by-config'],
    ['PATCHSTACK_TELEMETRY', 'disabled-by-telemetry-opt-out'],
  ])('%s=0 switches reporting off, and says which switch did it', async (name, expected) => {
    const { posted } = stubFetch();
    vi.stubEnv(name, '0');

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: AUTH,
      detectionFlushMs: 1,
    });

    expect(p.detectionReporting).toBe(expected);

    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));
    p.stop();
    await drain();

    expect(posted, 'an opt-out means no events leave the process').toEqual([]);
  });

  it('honours reportDetections: false as an opt-out', async () => {
    const { posted } = stubFetch();
    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: AUTH,
      reportDetections: false,
      detectionFlushMs: 1,
    });

    expect(p.detectionReporting).toBe('disabled-by-config');
    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));
    p.stop();
    await drain();

    expect(posted).toEqual([]);
  });
});

describe('the platform learns the state', () => {
  it('carries the state on the rules request, not a bit', async () => {
    const { capabilityHeaders } = stubFetch();
    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: AUTH,
    });

    const sent = capabilityHeaders.filter((v): v is string => typeof v === 'string');
    expect(sent.length).toBeGreaterThan(0);
    // Never the legacy bit: a boolean cannot say which of the reasons applies.
    expect(sent).not.toContain('enabled');
    p.stop();
  });

  it('carries the opt-out state, rather than saying nothing', async () => {
    // Silence would leave the platform unable to tell an opted-out site from one that never installed.
    const { capabilityHeaders } = stubFetch();
    vi.stubEnv('PATCHSTACK_REPORT_DETECTIONS', '0');

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: AUTH,
    });

    expect(capabilityHeaders).toContain('disabled-by-config');
    p.stop();
  });
});

describe('the settled state reaches the platform', () => {
  it('is acknowledged when resolution settles somewhere other than the fetch declared', async () => {
    // A site booting with an empty cache declares that it holds no managed rules, then receives them on
    // that same request. Without an acknowledgement the platform keeps the pre-resolution answer — and a
    // guard with refreshing switched off never sends another rules request.
    const { capabilityHeaders, bodies } = stubFetch();

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: AUTH,
      detectionFlushMs: 1,
    });
    await drain();
    await drain();

    // What the fetch carried, and what it settled on: different, which is why the acknowledgement exists.
    expect(capabilityHeaders).toContain('no-managed-rules');
    expect(p.detectionReporting).toBe('on');

    const announcements = bodies.filter((b) => typeof b.reporting_state === 'string');
    expect(announcements.map((b) => b.reporting_state)).toContain('on');
    // It carries no events — its only content is the state.
    for (const body of announcements) expect(body.detections).toEqual([]);

    // And it is accounted for separately. The event counters are measured in events, so an announcement
    // moving them would produce readings that describe no real delivery — `sent: 0` with `failed: 1` — and
    // would make an acknowledgement look like a delivered detection.
    const health = p.detectionHealth();
    expect(health.capability, 'the announcement is counted as a capability, not an event').toMatchObject({
      announced: 1,
      acknowledged: 1,
      failed: 0,
    });
    expect(health.capability.lastAcknowledgedAt).not.toBeNull();
    expect(
      { sent: health.sent, delivered: health.delivered, failed: health.failed, lastDeliveredAt: health.lastDeliveredAt },
      'no event has been delivered, so the event counters have not moved',
    ).toEqual({ sent: 0, delivered: 0, failed: 0, lastDeliveredAt: null });

    p.stop();
  });

  it('counts a refused announcement against capability, not against events', async () => {
    // The failure direction of the same separation: a refused announcement must not appear as a refused
    // detection, which is what `failed` counts.
    const { bodies } = stubFetch({ refuseDetections: true });

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: AUTH,
      detectionFlushMs: 1,
    });
    await drain();
    await drain();

    expect(bodies.filter((b) => typeof b.reporting_state === 'string').length).toBe(1);

    const health = p.detectionHealth();
    expect(health.capability).toMatchObject({ announced: 1, acknowledged: 0, failed: 1 });
    expect(health.failed, 'no event was refused, because none was sent').toBe(0);
    expect(health.sent).toBe(0);

    p.stop();
  });

  it('is not acknowledged when the fetch already declared the settled state', async () => {
    // A site whose store already holds a platform bundle declares `on` before the fetch and settles on
    // `on`, so there is nothing to correct and no extra request to make.
    let cached: unknown = { bundle: { firewall: [], whitelists: [], whitelist_keys: {} }, etag: '"v0"' };
    const { bodies } = stubFetch();

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: AUTH,
      detectionFlushMs: 1,
      ruleCache: { read: () => cached, write: (e: unknown) => { cached = e; } },
    });
    await drain();
    await drain();

    expect(p.detectionReporting).toBe('on');
    expect(bodies.filter((b) => typeof b.reporting_state === 'string')).toEqual([]);

    p.stop();
  });
});

describe('reporting follows a refresh', () => {
  it('stops when an opt-out appears under a running guard', async () => {
    // The mirror of recovery, and the direction that matters more: a guard that keeps reporting after
    // reporting is switched off is collecting retained evidence nobody asked it for. The state is read
    // afresh on each refresh rather than fixed at boot, so an operator who sets the variable and waits
    // for the next refresh gets what they asked for without a restart.
    //
    // Losing MANAGED status mid-process is not the case tested here: once a fetch has succeeded, the
    // guard holds the platform's rules in its memory tier, so they remain managed and `cache` is the
    // correct answer. The opt-out is the transition that is actually reachable.
    const { posted, capabilityHeaders } = stubFetch();

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: AUTH,
      detectionFlushMs: 1,
    });

    expect(p.detectionReporting).toBe('on');
    expect(p.detectionHealth).toBeTypeOf('function');

    const beforeRefresh = capabilityHeaders.length;
    vi.stubEnv('PATCHSTACK_REPORT_DETECTIONS', '0');
    await p.refresh();

    expect(p.detectionReporting, 'the state follows the opt-out').toBe('disabled-by-config');
    expect(p.detectionHealth, 'and the health surface goes with it').toBeUndefined();
    // And the request made BY that refresh says so. Carrying the previously reported state would mean the
    // platform learns of the opt-out only on the refresh after this one — or never, if there is none.
    expect(
      capabilityHeaders.slice(beforeRefresh),
      'the refresh request carries the state as of that request',
    ).toContain('disabled-by-config');

    const before = posted.length;
    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));
    p.stop();
    await drain();
    await drain();

    expect(posted.length, 'no event is sent after reporting stops').toBe(before);
  });

  it('starts once a refresh receives platform rules', async () => {
    // The recovery path. A guard that started on its own bundle because the first fetch failed must begin
    // reporting when the platform becomes reachable — not stay silent for the life of the process.
    const { posted, setRulesOk } = stubFetch();
    setRulesOk(false);

    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      pulseAuth: AUTH,
      rules: RULES,
      detectionFlushMs: 1,
      onError: () => {},
    });

    expect(p.detectionReporting).toBe('no-managed-rules');
    expect(p.detectionHealth).toBeUndefined();

    setRulesOk(true);
    const status = await p.refresh();

    expect(status).toMatchObject({ ok: true, origin: 'api' });
    expect(p.detectionReporting, 'the state follows the refresh').toBe('on');
    expect(p.detectionHealth, 'and so does the health surface').toBeTypeOf('function');

    await p.fetchGuard()(new Request('https://app.test/api/x?q=boom'));
    p.stop();
    await drain();
    await drain();

    expect(posted.length, 'events flow after recovery').toBeGreaterThan(0);
  });
});
