import { afterEach, describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// The guard screens an outbound call and then lets it go on. What goes on has to be something the
// fetch underneath can still send: a caller's Request with its body unread, and a body-carrying call
// in the shape the caller wrote it.

const originalFetch = globalThis.fetch;
const TARGET = 'http://93.184.216.34/api';
let protection: any;

afterEach(async () => {
  await protection?.stop();
  protection = undefined;
  globalThis.fetch = originalFetch;
});

async function setup(respond: (call: number) => Response = () => new Response('stub')) {
  const calls: Array<{ input: any; init: any }> = [];
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    calls.push({ input, init });
    return respond(calls.length);
  }) as any;
  protection = await createProtection({ egress: true, mode: 'block' });
  return calls;
}

const text = async (body: unknown) => new TextDecoder().decode(body as Uint8Array);

describe('a caller that manages redirects itself', () => {
  it.each(['manual', 'error'] as const)('has its own Request sent with the body unread (redirect: %s)', async (redirect) => {
    const calls = await setup();
    const request = new Request(TARGET, { method: 'POST', body: 'payload', redirect });

    expect(await (await fetch(request)).text()).toBe('stub');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(request);
    expect(request.bodyUsed).toBe(false);
    expect(await request.text()).toBe('payload');
  });

  it('has its own Request sent unread when the redirect mode is in init', async () => {
    const calls = await setup();
    const request = new Request(TARGET, { method: 'POST', body: 'payload' });
    const init = { redirect: 'manual' as const };

    await fetch(request, init);

    expect(calls[0]).toEqual({ input: request, init });
    expect(request.bodyUsed).toBe(false);
  });

  it('is still refused a disallowed destination', async () => {
    const calls = await setup();
    const request = new Request('http://127.0.0.1/admin', { method: 'POST', body: 'payload', redirect: 'manual' });

    await expect(fetch(request)).rejects.toThrow(/Patchstack blocked/);
    expect(calls).toEqual([]);
    expect(request.bodyUsed).toBe(false);
  });
});

describe('a call whose body can be read again', () => {
  it('goes out as the caller wrote it, with redirects left to the guard', async () => {
    const calls = await setup();
    const signal = AbortSignal.timeout(60_000);

    await fetch(TARGET, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' }, signal });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(TARGET);
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: '{"a":1}', redirect: 'manual' });
    expect(calls[0]!.init.signal).toBe(signal);
  });

  it('is replayed on a 307 from the copy the guard kept', async () => {
    const calls = await setup((call) =>
      call === 1 ? new Response(null, { status: 307, headers: { location: 'http://93.184.216.34/moved' } }) : new Response('landed'),
    );

    const response = await fetch(TARGET, { method: 'PUT', body: new TextEncoder().encode('replay-me') });

    expect(await response.text()).toBe('landed');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toBe('http://93.184.216.34/moved');
    expect(calls[1]!.init.method).toBe('PUT');
    expect(await text(calls[1]!.init.body)).toBe('replay-me');
  });

  it('has every hop screened', async () => {
    const calls = await setup(() => new Response(null, { status: 307, headers: { location: 'http://127.0.0.1/internal' } }));

    await expect(fetch(TARGET, { method: 'POST', body: 'x' })).rejects.toThrow(/Patchstack blocked/);
    expect(calls).toHaveLength(1);
  });
});

describe('a call whose body can be read once', () => {
  it('travels in a Request, and is still replayed on a 307', async () => {
    const calls = await setup((call) =>
      call === 1 ? new Response(null, { status: 307, headers: { location: 'http://93.184.216.34/moved' } }) : new Response('landed'),
    );

    const response = await fetch(new Request(TARGET, { method: 'POST', body: 'from-request' }));

    expect(await response.text()).toBe('landed');
    expect(calls[0]!.input).toBeInstanceOf(Request);
    expect(await text(calls[1]!.init.body)).toBe('from-request');
  });
});
