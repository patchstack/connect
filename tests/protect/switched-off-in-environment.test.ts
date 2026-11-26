import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// `PATCHSTACK_MODE=off` is the switch for an incident: with it set the guard screens nothing, reports
// nothing and reaches no network, and the code that calls it runs unchanged.

const rules = {
  firewall: [{ id: 'traversal', rule_v2: [{ parameter: 'get.f', mutations: ['urldecode'], match: { type: 'contains', value: '../' } }] }],
  whitelists: [],
  whitelist_keys: {},
  enforcement: 'block',
};
const ATTACK = 'https://app.test/?f=../../etc/passwd';
const SAID = Symbol.for('patchstack.connect.switched-off-said');
const originalFetch = globalThis.fetch;

let protection: any;

afterEach(async () => {
  await protection?.stop();
  protection = undefined;
  delete process.env.PATCHSTACK_MODE;
  delete (globalThis as any)[SAID];
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('a guard switched off in the environment', () => {
  it('lets through what the same guard blocks when switched on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    protection = await createProtection({ mode: 'block', reportDetections: false, rules });
    expect((await protection.fetchGuard()(new Request(ATTACK)))?.status).toBe(403);
    await protection.stop();

    process.env.PATCHSTACK_MODE = 'off';
    protection = await createProtection({ mode: 'block', reportDetections: false, rules });

    expect(protection.mode).toBe('off');
    expect(await protection.fetchGuard()(new Request(ATTACK))).toBeNull();
  });

  it('hands handlers, responses and middleware back untouched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PATCHSTACK_MODE = 'off';
    protection = await createProtection({ mode: 'block', egress: true, rules });

    const handler = async () => new Response('from the app');
    const response = new Response('body');
    const next = vi.fn();

    expect(protection.fetch(handler)).toBe(handler);
    expect(await protection.screenResponse(response, new Request(ATTACK))).toBe(response);
    protection.express()({}, {}, next);
    protection.node()({}, {}, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(protection.screenNodeResponse({}, new Request(ATTACK))).toBeUndefined();
  });

  it('leaves fetch alone and reaches no network, even with a token and outbound screening asked for', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: unknown[] = [];
    const stub = (async (input: unknown) => {
      calls.push(input);
      return new Response('{}');
    }) as any;
    globalThis.fetch = stub;
    process.env.PATCHSTACK_MODE = 'off';

    protection = await createProtection({ mode: 'block', egress: true, token: 'not-a-real-token', siteUuid: '11111111-2222-3333-4444-555555555555' });

    expect(globalThis.fetch).toBe(stub);
    expect(calls).toEqual([]);
    expect(protection.detectionReporting).toBe('disabled-by-config');
    expect(protection.detectionHealth).toBeUndefined();
    expect(protection.ruleSource).toMatchObject({ ok: false, origin: 'empty' });
    expect(protection.synchronization).toMatchObject({ mode: 'off', matched: false });
    expect(protection.coverage()).toEqual({ skipped: {} });
    await expect(protection.stop()).resolves.toBeUndefined();
    await expect(protection.stopRefresh()).resolves.toBeUndefined();
  });

  it('says so once in the log, however many guards are created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PATCHSTACK_MODE = 'off';

    protection = await createProtection({ rules });
    await createProtection({ rules });

    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('PATCHSTACK_MODE=off'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('the guard is switched off');
  });

  it('is not switched off by the option, or by any other value', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    protection = await createProtection({ mode: 'off' as never, reportDetections: false, rules });
    expect(protection.mode).not.toBe('off');
    await protection.stop();

    process.env.PATCHSTACK_MODE = 'OFF';
    protection = await createProtection({ mode: 'block', reportDetections: false, rules });
    expect(protection.mode).toBe('block');
  });
});
