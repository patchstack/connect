import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// Enforcement used to be per-site: the whole bundle blocked or the whole bundle only detected. A rule may
// now carry `enforcement: 'dry-run'`, which wins over block mode for that rule alone. Auto-generated rules
// arrive that way — their coordinate comes from best-effort static analysis, so they detect until a probe or
// a human justifies them — WITHOUT holding back the hand-authored rules on the same site.
const handAuthored = {
  id: 'human-1',
  title: 'Block traversal (authored against a CVE)',
  rule_v2: [{ parameter: 'get.file', match: { type: 'contains', value: '..' } }],
};

const generated = {
  id: 'pulse-1',
  title: 'Block SQLi on the app\'s own parameter',
  enforcement: 'dry-run',
  rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'union select' } }],
};

/** The runtime takes a BUNDLE, not a bare rule list. */
const bundle = (...firewall: unknown[]) => ({ firewall, whitelists: [], whitelist_keys: {} });

const ok = () => new Response('ok', { status: 200 });
const get = (path: string) => new Request(`https://app.example.com${path}`);

describe('per-rule enforcement', () => {
  it('does not block a dry-run rule even when the site is in block mode', async () => {
    const detections: any[] = [];
    const protection = await createProtection({
      rules: bundle(generated),
      mode: 'block',
      onDetect: (d: unknown) => detections.push(d),
    });
    const handler = protection.fetch(ok);

    const response = await handler(get('/search?q=union%20select%201'));

    expect(response.status).toBe(200);
    // Detected, and reported as what actually happened — a consumer counting blocks must not over-report.
    expect(detections).toHaveLength(1);
    expect(detections[0].mode).toBe('dry-run');
    expect(detections[0].rule.id).toBe('pulse-1');
  });

  it('still blocks a rule that does not opt out', async () => {
    const protection = await createProtection({ rules: bundle(handAuthored), mode: 'block' });
    const handler = protection.fetch(ok);

    expect((await handler(get('/read?file=../../etc/passwd'))).status).toBe(403);
  });

  it('applies both policies in one bundle — the point of the change', async () => {
    const detections: any[] = [];
    const protection = await createProtection({
      rules: bundle(handAuthored, generated),
      mode: 'block',
      onDetect: (d: unknown) => detections.push(d),
    });
    const handler = protection.fetch(ok);

    const blocked = await handler(get('/read?file=../../etc/passwd'));
    const observed = await handler(get('/search?q=union%20select%201'));

    expect(blocked.status).toBe(403);
    expect(observed.status).toBe(200);
    expect(detections.map((d) => [d.rule.id, d.mode])).toEqual([
      ['human-1', 'block'],
      ['pulse-1', 'dry-run'],
    ]);
  });

  it('leaves a rule with no enforcement field following the bundle, as before', async () => {
    // An older server never sends the field; behaviour must be identical to today.
    const dryRunSite = await createProtection({ rules: bundle(handAuthored), mode: 'dry-run' });
    expect((await dryRunSite.fetch(ok)(get('/read?file=../../etc/passwd'))).status).toBe(200);
  });

  it('ignores an unrecognised enforcement value rather than failing open', async () => {
    // A future value ('observe', say) must not accidentally read as "do not block": unknown means
    // "follow the site", which is the conservative reading for a protection control.
    const odd = { ...generated, id: 'pulse-2', enforcement: 'observe-only' };
    const protection = await createProtection({ rules: bundle(odd), mode: 'block' });

    expect((await protection.fetch(ok)(get('/search?q=union%20select%201'))).status).toBe(403);
  });
});

// Per-rule enforcement has to hold in EVERY phase. A generated response rule that still redacts, or a
// generated egress rule that still prevents an outbound request, is not "detecting until justified" — it is
// changing what the app does, which is exactly what dry-run exists to avoid.
describe('per-rule enforcement in the response and egress phases', () => {
  const secretResponse = () =>
    new Response(JSON.stringify({ token: 'sk_live_abcdef', ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const redactRule = (extra: object = {}) => ({
    id: 'pulse-resp',
    phase: 'response',
    category: 'secret',
    action: 'redact',
    rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'sk_live_' } }],
    ...extra,
  });

  it('does not redact the body for a dry-run response rule on a blocking site', async () => {
    const detections: any[] = [];
    const protection: any = await createProtection({
      rules: bundle(),
      responseRules: [redactRule({ enforcement: 'dry-run' })],
      mode: 'block',
      onDetect: (d: unknown) => detections.push(d),
    });

    const screened = await protection.screenResponse(secretResponse());

    // The secret is still there: observed, not rewritten.
    expect(JSON.parse(await screened.text()).token).toBe('sk_live_abcdef');
    expect(detections).toHaveLength(1);
    expect(detections[0].mode).toBe('dry-run');
  });

  it('still redacts for a response rule that does not opt out', async () => {
    const protection: any = await createProtection({
      rules: bundle(),
      responseRules: [redactRule()],
      mode: 'block',
    });

    const screened = await protection.screenResponse(secretResponse());

    expect(JSON.parse(await screened.text()).token).not.toBe('sk_live_abcdef');
  });

  it('does not stop an outbound request for a dry-run egress rule', async () => {
    // Egress screening wraps the global fetch, so the observable behaviour is whether the call throws.
    const detections: any[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({ marker: 'stub' })) as any;
    const protection: any = await createProtection({
      egress: true,
      mode: 'block',
      egressRules: [{
        id: 'pulse-egress',
        phase: 'egress',
        category: 'ssrf',
        enforcement: 'dry-run',
        rule_v2: [{ parameter: 'egress.host', match: { type: 'contains', value: 'evil.com' } }],
      }],
      onDetect: (d: unknown) => detections.push(d),
    });
    try {
      // Recorded, and allowed through: blocking a request the app makes is at least as disruptive as
      // blocking one it receives, so dry-run has to mean dry-run here too.
      expect((await (globalThis.fetch as any)('https://api.evil.com/x')).marker).toBe('stub');
      expect(detections.map((d) => d.mode)).toEqual(['dry-run']);
    } finally {
      protection.uninstallEgress?.();
      globalThis.fetch = orig;
    }
  });

  it('still stops an outbound request for an egress rule that does not opt out', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({ marker: 'stub' })) as any;
    const protection: any = await createProtection({
      egress: true,
      mode: 'block',
      egressRules: [{
        id: 'pulse-egress-2',
        phase: 'egress',
        category: 'ssrf',
        rule_v2: [{ parameter: 'egress.host', match: { type: 'contains', value: 'evil.com' } }],
      }],
    });
    try {
      await expect(globalThis.fetch('https://api.evil.com/x')).rejects.toThrow();
    } finally {
      protection.uninstallEgress?.();
      globalThis.fetch = orig;
    }
  });
});
