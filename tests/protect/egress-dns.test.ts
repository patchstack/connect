import { afterEach, describe, expect, it } from 'vitest';
import { installEgressGuard, screenResolved } from '../../src/protect/egress.js';

// A hostname that passes the name check but resolves to an internal/metadata IP must be blocked
// (DNS rebinding). We inject a fake resolver so the tests are deterministic — no real DNS.

const isInternal = (host: string) => /^(?:127\.|10\.|169\.254\.|192\.168\.)/.test(String(host)) || host === '::1';
const shouldBlock = (_url: string, host: string | null) => (host ? isInternal(host) : false);
const target = { url: 'http://rebind.test/', host: 'rebind.test', method: 'GET' };
const nodeHttp = async (): Promise<any> => {
  const ns: any = await import('node:http');
  return ns.default ?? ns;
};

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('screenResolved', () => {
  it('flags the first internal address a hostname resolves to', () => {
    const hit = screenResolved([{ address: '93.184.216.34' }, { address: '169.254.169.254' }], target, shouldBlock);
    expect(hit).toBe('169.254.169.254');
  });

  it('returns null when every resolved address is public', () => {
    expect(screenResolved([{ address: '93.184.216.34' }, { address: '1.1.1.1' }], target, shouldBlock)).toBeNull();
  });
});

describe('egress DNS-rebinding screen (node:http)', () => {
  it('blocks a hostname that resolves to an internal address', async () => {
    restore = await installEgressGuard({
      shouldBlock,
      lookup: (_h: string, _o: any, cb: any) => cb(null, [{ address: '169.254.169.254', family: 4 }]),
    });
    const http = await nodeHttp();
    const err: any = await new Promise((resolve) => {
      const req = http.request('http://rebind.test/');
      req.on('error', resolve);
      req.end();
    });
    expect(String(err)).toMatch(/Patchstack blocked/);
    expect(String(err)).toMatch(/169\.254\.169\.254/); // reports what it resolved to
  });

  it('allows and pins a hostname that resolves to a permitted address', async () => {
    const http = await nodeHttp();
    const server = http.createServer((_req: any, res: any) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      // 127.* is permitted by this predicate, so the pinned resolution reaches the local server.
      restore = await installEgressGuard({
        shouldBlock: (_url: string, host: string | null) => /^(?:169\.254\.|10\.|192\.168\.)/.test(String(host)),
        lookup: (_h: string, _o: any, cb: any) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
      });
      const body: string = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: 'public.test', port, path: '/' }, (res: any) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c));
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe('ok'); // connected via the vetted 127.0.0.1 resolution
    } finally {
      server.close();
    }
  });

  it('does not screen when dnsScreen is disabled (our resolver is never wired in)', async () => {
    const http = await nodeHttp();
    const server = http.createServer((_req: any, res: any) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    let called = false;
    try {
      restore = await installEgressGuard({
        shouldBlock,
        dnsScreen: false,
        lookup: () => {
          called = true; // our screening resolver — must stay untouched when disabled
        },
      });
      const body: string = await new Promise((resolve, reject) => {
        // family: 4 pins localhost → 127.0.0.1 (avoids ::1 when the server bound only IPv4).
        const req = http.request({ hostname: 'localhost', port, path: '/', family: 4 }, (res: any) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c));
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe('ok');
      expect(called).toBe(false); // request used the platform resolver, not ours
    } finally {
      server.close();
    }
  });
});
