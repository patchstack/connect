import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createProtection } from '../../src/protect/runtime.js';

// Following redirects on the caller's behalf must look like native `follow` from the outside: every
// hop is sent with the caller's own fetch options, and the final response says it was redirected.

type Call = { url: string; init: any };
const originalFetch = globalThis.fetch;
let protection: any;

afterEach(() => {
  protection?.uninstallEgress?.();
  protection?.stop?.();
  protection = undefined;
  globalThis.fetch = originalFetch;
});

async function guardOver(responses: Response[]) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    calls.push({ url: typeof input === 'string' ? input : input.url, init });
    return responses.shift() ?? new Response('unexpected');
  }) as any;
  protection = await createProtection({ egress: true, mode: 'block' });
  return calls;
}

const START = 'http://203.0.113.10/start';

describe('egress redirect following keeps the caller options', () => {
  it('sends every hop with the caller options and reports the redirect', async () => {
    const calls = await guardOver([
      new Response(null, { status: 302, headers: { location: '/middle' } }),
      new Response(null, { status: 301, headers: { location: 'http://203.0.113.11/end' } }),
      new Response('done'),
    ]);
    const dispatcher = { name: 'caller-dispatcher' };
    const response = await fetch(START, { dispatcher, keepalive: true, referrerPolicy: 'no-referrer' } as any);

    expect(await response.text()).toBe('done');
    expect(response.redirected).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([START, 'http://203.0.113.10/middle', 'http://203.0.113.11/end']);
    for (const call of calls) {
      expect(call.init).toMatchObject({ dispatcher, keepalive: true, referrerPolicy: 'no-referrer', redirect: 'manual' });
    }
  });

  it('does not report a redirect for a direct response', async () => {
    await guardOver([new Response('direct')]);
    const response = await fetch(START, { keepalive: true });
    expect(await response.text()).toBe('direct');
    expect(response.redirected).toBe(false);
  });

  it('replays a 307 body alongside the caller options', async () => {
    const calls = await guardOver([
      new Response(null, { status: 307, headers: { location: '/again' } }),
      new Response('ok'),
    ]);
    const dispatcher = { name: 'caller-dispatcher' };
    await fetch(START, { method: 'POST', body: 'payload', dispatcher } as any);

    expect(calls[1].init).toMatchObject({ method: 'POST', dispatcher, redirect: 'manual' });
    expect(new TextDecoder().decode(calls[1].init.body)).toBe('payload');
  });

  it('still drops the body on a 303', async () => {
    const calls = await guardOver([
      new Response(null, { status: 303, headers: { location: '/see-other' } }),
      new Response('ok'),
    ]);
    await fetch(START, { method: 'POST', body: 'payload', keepalive: true });
    expect(calls[1].init).toMatchObject({ method: 'GET', keepalive: true });
    expect(calls[1].init.body).toBeUndefined();
  });

  it('uses the caller dispatcher for every hop of a real redirect', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/next' });
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => res.end(['final', req.url, Buffer.concat(chunks).toString()].filter(Boolean).join(' ')));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      protection = await createProtection({ egress: true, mode: 'block', allowHosts: ['127.0.0.1'] });
      const global = (globalThis as any)[Symbol.for('undici.globalDispatcher.1')];
      const paths: string[] = [];
      const dispatcher = {
        dispatch: (options: any, handler: any) => {
          paths.push(options.path);
          return global.dispatch(options, handler);
        },
      };
      const response = await fetch(`http://127.0.0.1:${port}/start`, { dispatcher } as any);
      expect(await response.text()).toBe('final /next');
      expect(response.redirected).toBe(true);
      expect(paths).toEqual(['/start', '/next']);

      // A streamed body belongs to the first hop's Request and is sent once.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('streamed'));
          controller.close();
        },
      });
      const posted = await fetch(`http://127.0.0.1:${port}/echo`, { method: 'POST', body: stream, duplex: 'half' } as any);
      expect(await posted.text()).toBe('final /echo streamed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
