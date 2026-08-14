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
