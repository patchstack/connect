import { describe, it, expect, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// Fail-open coverage must be OBSERVABLE. The guard deliberately passes traffic it can't inspect
// (oversized bodies, live streams, binary bodies, resolver failures) — each of those is a real hole in
// enforcement, so it must be counted in `protection.coverage()` and reported to `onSkip`, not silent.

const AWS = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';

describe('response-phase skips are recorded', () => {
  it('records a body-cap bypass and reports it to onSkip', async () => {
    const skips: any[] = [];
    const p: any = await createProtection({ mode: 'block', onSkip: (s: any) => skips.push(s) });
    // A body past the screening cap is served UNSCREENED — the secret survives, which is exactly why
    // it must be observable.
    const big = JSON.stringify({ apiKey: AWS, pad: 'x'.repeat(600 * 1024) });
    const out = await p.screenResponse(
      new Response(big, { status: 200, headers: { 'content-type': 'application/json' } }),
      new Request('https://app.com/x'),
    );
    expect((await out.text()).includes(AWS)).toBe(true); // unscreened (documented fail-open)
    expect(p.coverage().skipped['response:body-cap']).toBe(1);
    expect(skips).toEqual([expect.objectContaining({ phase: 'response', reason: 'body-cap' })]);
  });

  it('records a live-stream passthrough distinctly from a cap', async () => {
    const p: any = await createProtection({ mode: 'block' });
    await p.screenResponse(
      new Response('data: hi\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      new Request('https://app.com/x'),
    );
    expect(p.coverage().skipped['response:live-stream']).toBe(1);
  });

  it('records a binary body skip', async () => {
    const p: any = await createProtection({ mode: 'block' });
    await p.screenResponse(
      new Response(new Uint8Array([0, 1, 2, 3, 255]), { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      new Request('https://app.com/x'),
    );
    expect(p.coverage().skipped['response:binary-body']).toBe(1);
  });

  it('counts repeats and leaves coverage empty when everything was inspected', async () => {
    const p: any = await createProtection({ mode: 'block' });
    const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    await p.screenResponse(ok(), new Request('https://app.com/x'));
    expect(p.coverage().skipped).toEqual({});

    const stream = () => new Response('data: x\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    await p.screenResponse(stream(), new Request('https://app.com/x'));
    await p.screenResponse(stream(), new Request('https://app.com/x'));
    expect(p.coverage().skipped['response:live-stream']).toBe(2);
  });

  it('never lets a throwing onSkip affect request handling', async () => {
    const p: any = await createProtection({
      mode: 'block',
      onSkip: () => { throw new Error('reporting blew up'); },
    });
    const out = await p.screenResponse(
      new Response('data: x\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      new Request('https://app.com/x'),
    );
    expect(out.status).toBe(200); // served fine despite the callback throwing
  });
});

describe('startup is not blocked by a slow rule API', () => {
  it('boots from the bundled fallback within the boot budget when the fetch hangs', async () => {
    // A hosted platform fails a deploy whose health check is slow, so the INITIAL fetch gets a short
    // budget (bootTimeoutMs) and we boot on last-known-good / bundled rules instead of waiting.
    const fallback = {
      firewall: [{ id: 'fb-1', rule_v2: [{ parameter: 'raw', match: { type: 'contains', value: '__proto__' } }] }],
      whitelists: [],
      whitelist_keys: {},
    };
    vi.stubGlobal('fetch', vi.fn((_u: any, init: any) => new Promise((_res, rej) => {
      // Never resolve: only the abort signal ends this, which is the point of the budget.
      init?.signal?.addEventListener?.('abort', () => rej(new Error('The operation was aborted')));
    })));
    const started = Date.now();
    const p: any = await createProtection({
      siteUuid: 'site-1',
      pulseRulesUrl: 'https://x.test/monitor/pulse',
      rules: fallback as any,
      mode: 'block',
      bootTimeoutMs: 300,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3000); // did NOT wait the full 30s client timeout
    expect(p.rules.request.map((r: any) => r.id)).toEqual(['fb-1']); // protected via the fallback
    vi.restoreAllMocks();
  });
});
