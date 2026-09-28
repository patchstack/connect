import http, { request as namedRequest, get as namedGet } from 'node:http';
import * as httpNamespace from 'node:http';
import https, { request as namedHttpsRequest } from 'node:https';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * Outbound screening on `node:http` / `node:https` has to judge the destination Node will actually
 * connect to, through whichever of the module's call forms and import styles the application uses.
 *
 * A local server stands in for an internal address. Every case asks for it; a case passes when the call
 * is refused before a socket opens, and the server records nothing.
 */

let server: http.Server;
let port: number;
let reached: string[];

beforeEach(async () => {
  reached = [];
  server = http.createServer((req, res) => {
    reached.push(req.url ?? '');
    res.end('internal');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function guarded<T>(body: () => Promise<T> | T): Promise<T> {
  const protection = await createProtection({ egress: true, mode: 'block', allowHosts: [], onError: () => {} });
  try {
    return await body();
  } finally {
    protection.uninstallEgress?.();
  }
}

/** 'refused' when the guard stops the call; otherwise what the server answered. */
function attempt(make: () => http.ClientRequest): Promise<string> {
  return new Promise((resolve) => {
    let req: http.ClientRequest;
    try {
      req = make();
    } catch (err) {
      resolve(/Patchstack blocked/.test(String(err)) ? 'refused' : `threw: ${String(err)}`);
      return;
    }
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve('reached'));
    });
    req.on('error', (err) => resolve(/Patchstack blocked/.test(String(err)) ? 'refused' : `error: ${err.message}`));
    req.end();
  });
}

describe('the destination Node will connect to', () => {
  it('is the one screened when options name a different host than the URL', async () => {
    const outcome = await guarded(() => attempt(() => http.request('http://example.invalid/a', { hostname: '127.0.0.1', port })));

    expect(outcome).toBe('refused');
    expect(reached).toEqual([]);
  });

  it('is the one screened for get() as well', async () => {
    const outcome = await guarded(() =>
      attempt(() => http.get('http://example.invalid/b', { hostname: '127.0.0.1', port }).on('error', () => {})),
    );

    expect(outcome).toBe('refused');
    expect(reached).toEqual([]);
  });

  it('is the one screened when the URL is a URL object', async () => {
    const outcome = await guarded(() => attempt(() => http.request(new URL('http://example.invalid/c'), { hostname: '127.0.0.1', port })));

    expect(outcome).toBe('refused');
  });

  it('follows the URL when options only override something other than the host', async () => {
    // `host` does not beat the URL's own hostname, so this goes where the URL says — the local server.
    const outcome = await guarded(() => attempt(() => http.request(`http://127.0.0.1:${port}/d`, { host: 'example.invalid', headers: {} })));

    expect(outcome).toBe('refused');
  });
});

describe('every way the module is reached', () => {
  it('covers a named import', async () => {
    const outcome = await guarded(() => attempt(() => namedRequest(`http://127.0.0.1:${port}/e`)));

    expect(outcome).toBe('refused');
    expect(reached).toEqual([]);
  });

  it('covers a named get import', async () => {
    const outcome = await guarded(() => attempt(() => namedGet(`http://127.0.0.1:${port}/f`).on('error', () => {})));

    expect(outcome).toBe('refused');
  });

  it('covers a namespace import', async () => {
    const outcome = await guarded(() => attempt(() => httpNamespace.request(`http://127.0.0.1:${port}/g`)));

    expect(outcome).toBe('refused');
  });

  it('covers a named https import', async () => {
    const outcome = await guarded(() => attempt(() => namedHttpsRequest(`https://127.0.0.1:${port}/h`)));

    expect(outcome).toBe('refused');
  });

  it('covers a request constructed directly', async () => {
    const outcome = await guarded(() => attempt(() => new http.ClientRequest(`http://127.0.0.1:${port}/i`)));

    expect(outcome).toBe('refused');
    expect(reached).toEqual([]);
  });

  it('covers a subclass, and keeps the subclass what it is', async () => {
    await guarded(async () => {
      class Traced extends http.ClientRequest {
        traced = true;
      }
      expect(await attempt(() => new Traced(`http://127.0.0.1:${port}/k`))).toBe('refused');

      const allowed = new Traced('http://example.invalid/');
      allowed.on('error', () => {});
      allowed.destroy();
      expect(allowed).toBeInstanceOf(Traced);
      expect(allowed.traced).toBe(true);
    });
  });

  it('leaves an ordinary request recognisable as a ClientRequest', async () => {
    await guarded(() => {
      const req = http.request('http://example.invalid/');
      req.on('error', () => {});
      req.destroy();

      expect(req).toBeInstanceOf(http.ClientRequest);
    });
  });

  it('hands every import back its original once uninstalled', async () => {
    const before = { request: http.request, named: namedRequest, ns: httpNamespace.request, ctor: http.ClientRequest, https: https.request };
    await guarded(() => {
      expect(namedRequest).not.toBe(before.named);
    });

    expect({ request: http.request, named: namedRequest, ns: httpNamespace.request, ctor: http.ClientRequest, https: https.request }).toEqual(before);
    expect(await attempt(() => namedRequest(`http://127.0.0.1:${port}/j`))).toBe('reached');
  });
});
