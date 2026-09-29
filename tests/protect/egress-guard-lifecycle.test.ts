import { afterEach, describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { installEgressGuard } from '../../src/protect/egress.js';

// The egress guard is process-wide: fetch and node:http are shared by every protection in the process.
// Each protection registers its own screen, a call is refused when any registered screen refuses it, a
// protection leaving takes only its own screen with it, and stop() is one of the ways it leaves.

const originalFetch = globalThis.fetch;
const active: any[] = [];

afterEach(async () => {
  for (const protection of active.splice(0)) await protection.stop();
  globalThis.fetch = originalFetch;
});

async function nodeHttp() {
  const ns: any = await import('node:http');
  return ns.default ?? ns;
}

const refuse = (id: string, host: string) => ({
  id,
  category: 'ssrf',
  rule_v2: [{ parameter: 'egress.host', match: { type: 'equals', value: host } }],
});

async function guard(host: string, blocks: string[] = []) {
  const protection: any = await createProtection({
    egress: true,
    mode: 'block',
    screenDns: false,
    egressRules: [refuse(`refuse-${host}`, host)],
    onEgressBlock: ({ host: blocked }: { host: string }) => blocks.push(blocked),
  });
  active.push(protection);
  return protection;
}

function stubFetch() {
  const seen: string[] = [];
  globalThis.fetch = (async (input: any) => {
    seen.push(typeof input === 'string' ? input : input.url);
    return new Response('stub');
  }) as any;
  return seen;
}

const refused = (call: () => unknown) => {
  try {
    call();
    return false;
  } catch (error) {
    return /Patchstack blocked/.test(String(error));
  }
};

describe('egress guard lifecycle', () => {
  it('restores fetch and node:http when the protection stops', async () => {
    stubFetch();
    const before = globalThis.fetch;
    const http = await nodeHttp();
    const request = http.request;
    const ClientRequest = http.ClientRequest;

    const protection = await guard('first.test');
    expect(globalThis.fetch).not.toBe(before);
    expect(http.request).not.toBe(request);

    await protection.stop();
    active.splice(active.indexOf(protection), 1);
    expect(globalThis.fetch).toBe(before);
    expect(http.request).toBe(request);
    expect(http.ClientRequest).toBe(ClientRequest);
  });

  it('screens a call against every registered protection', async () => {
    const seen = stubFetch();
    const firstBlocks: string[] = [];
    const secondBlocks: string[] = [];
    await guard('first.test', firstBlocks);
    await guard('second.test', secondBlocks);
    const http = await nodeHttp();

    await expect(fetch('http://first.test/')).rejects.toThrow(/Patchstack blocked/);
    await expect(fetch('http://second.test/')).rejects.toThrow(/Patchstack blocked/);
    expect(await (await fetch('http://third.test/')).text()).toBe('stub');
    expect(refused(() => http.request('http://first.test/'))).toBe(true);
    expect(refused(() => http.request('http://second.test/'))).toBe(true);

    expect(firstBlocks).toEqual(['first.test', 'first.test']);
    expect(secondBlocks).toEqual(['second.test', 'second.test']);
    expect(seen).toEqual(['http://third.test/']);
  });

  it("refuses a host one protection allows when another protection refuses it", async () => {
    const seen = stubFetch();
    const trusting: any = await createProtection({ egress: true, mode: 'block', allowHosts: ['127.0.0.1'] });
    active.push(trusting);
    expect(await (await fetch('http://127.0.0.1/admin')).text()).toBe('stub');

    const strict: any = await createProtection({ egress: true, mode: 'block' });
    active.push(strict);
    await expect(fetch('http://127.0.0.1/admin')).rejects.toThrow(/Patchstack blocked/);
    const http = await nodeHttp();
    expect(refused(() => http.request('http://127.0.0.1/admin'))).toBe(true);

    await strict.stop();
    active.splice(active.indexOf(strict), 1);
    expect(await (await fetch('http://127.0.0.1/admin')).text()).toBe('stub');
    expect(seen).toEqual(['http://127.0.0.1/admin', 'http://127.0.0.1/admin']);
  });

  it('keeps the remaining screens when one protection leaves', async () => {
    stubFetch();
    const before = globalThis.fetch;
    const first = await guard('first.test');
    const second = await guard('second.test');
    const http = await nodeHttp();

    first.uninstallEgress();
    expect(await (await fetch('http://first.test/')).text()).toBe('stub');
    await expect(fetch('http://second.test/')).rejects.toThrow(/Patchstack blocked/);
    expect(refused(() => http.request('http://second.test/'))).toBe(true);

    // Leaving twice changes nothing for the protection still registered.
    first.uninstallEgress();
    await expect(fetch('http://second.test/')).rejects.toThrow(/Patchstack blocked/);

    await second.stop();
    active.length = 0;
    expect(globalThis.fetch).toBe(before);
  });

  it('pins a node:http call to one resolution that every resolving screen checked', async () => {
    const http = await nodeHttp();
    const internal = [{ address: '10.0.0.5', family: 4 }];
    const asked: string[] = [];
    const blocks: string[] = [];
    const install = (name: string, allowHosts: string[] = []) =>
      installEgressGuard({
        shouldBlock: (_url: string, host: string | null) => host === '10.0.0.5',
        onBlock: () => blocks.push(name),
        allowHosts,
        lookup: (_host: string, _options: unknown, callback: any) => {
          asked.push(name);
          callback(null, internal);
        },
      });
    const connectError = () =>
      new Promise<string>((resolve) => {
        const request = http.request({ host: 'service.test', port: 80, path: '/' });
        request.on('error', (error: Error) => resolve(error.message));
        request.end();
      });

    const trusting = await install('trusting', ['service.test']);
    const strict = await install('strict');
    const later = await install('later');
    try {
      expect(await connectError()).toContain('resolved to 10.0.0.5');
      // Resolved once, through the earliest screen that screens this host, and checked by each of them.
      expect(asked).toEqual(['strict']);
      expect(blocks).toEqual(['strict', 'later']);
    } finally {
      trusting();
      strict();
      later();
    }
  });

  it("checks a fetch call's resolution against every screen that resolves it", async () => {
    const seen = stubFetch();
    const blocks: string[] = [];
    const install = (name: string, allowHosts: string[] = []) =>
      installEgressGuard({
        shouldBlock: (_url: string, host: string | null) => host === '10.0.0.5',
        onBlock: () => blocks.push(name),
        allowHosts,
        lookup: (_host: string, _options: unknown, callback: any) => callback(null, [{ address: '10.0.0.5', family: 4 }]),
      });

    const trusting = await install('trusting', ['service.test']);
    const strict = await install('strict');
    try {
      await expect(fetch('http://service.test/')).rejects.toThrow(/Patchstack blocked/);
      expect(blocks).toEqual(['strict']);
      expect(seen).toEqual([]);
    } finally {
      trusting();
      strict();
    }
  });

  it('screens a later protection after an earlier one stopped', async () => {
    stubFetch();
    const first = await guard('first.test');
    await first.stop();
    active.length = 0;

    await guard('second.test');
    await expect(fetch('http://second.test/')).rejects.toThrow(/Patchstack blocked/);
    expect(await (await fetch('http://first.test/')).text()).toBe('stub');
  });
});
