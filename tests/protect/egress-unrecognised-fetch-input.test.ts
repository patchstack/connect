import { afterEach, describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// A fetch call whose arguments the runtime's `Request` refuses is still handed to the underlying fetch,
// which may accept it. Its destination is screened when it can be read, and counted as unscreened when
// it cannot.

const originalFetch = globalThis.fetch;
let protection: any;

afterEach(async () => {
  await protection?.stop();
  protection = undefined;
  globalThis.fetch = originalFetch;
});

async function setup() {
  const forwarded: unknown[] = [];
  globalThis.fetch = (async (input: unknown) => {
    forwarded.push(input);
    return new Response('stub');
  }) as any;
  const skips: any[] = [];
  protection = await createProtection({ egress: true, mode: 'block', onSkip: (event: any) => skips.push(event) });
  return { forwarded, skips };
}

describe('fetch input the runtime Request refuses', () => {
  it('screens a readable destination', async () => {
    const { forwarded, skips } = await setup();
    const input = { url: 'http://127.0.0.1/admin' };

    await expect(fetch(input as any)).rejects.toThrow(/Patchstack blocked/);
    expect(forwarded).toEqual([]);
    expect(skips).toEqual([]);
  });

  it('passes a readable public destination on as it came', async () => {
    const { forwarded, skips } = await setup();
    const input = { href: 'http://93.184.216.34/api', method: 'post' };

    expect(await (await fetch(input as any)).text()).toBe('stub');
    expect(forwarded).toEqual([input]);
    expect(skips).toEqual([]);
  });

  it('counts an unreadable destination as unscreened', async () => {
    const { forwarded, skips } = await setup();

    expect(await (await fetch(12345 as any)).text()).toBe('stub');
    expect(forwarded).toEqual([12345]);
    expect(skips).toMatchObject([{ phase: 'egress', reason: 'unrecognised-request' }]);
    expect(protection.coverage().skipped).toMatchObject({ 'egress:unrecognised-request': 1 });
  });
});
