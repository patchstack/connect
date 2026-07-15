import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// The egress guard patches node:http/https (not just global fetch) so outbound calls made via
// those modules — axios, got, the raw client — are screened for SSRF too.

async function nodeHttp() {
  const ns: any = await import('node:http');
  return ns.default ?? ns;
}

describe('egress guard — node:http', () => {
  it('blocks a node:http request to an internal/metadata host, allows external, restores on uninstall', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('stub')) as any; // avoid real network during setup
    const p: any = await createProtection({ egress: true, mode: 'block', allowHosts: [] });
    try {
      const http = await nodeHttp();
      expect(http.__patchstackGuarded).toBe(true); // module was patched

      let blocked = false;
      try {
        http.request('http://169.254.169.254/latest/meta-data/');
      } catch (err) {
        blocked = /Patchstack blocked/.test(String(err));
      }
      expect(blocked).toBe(true); // internal host → thrown before any socket

      // An external host is allowed (guard doesn't throw); destroy immediately, swallow the socket error.
      let threw = false;
      try {
        const r = http.request('http://example.com/');
        r.on('error', () => {});
        r.destroy();
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    } finally {
      p.uninstallEgress?.();
      globalThis.fetch = origFetch;
    }

    const http = await nodeHttp();
    expect(http.__patchstackGuarded).toBeUndefined(); // restored after uninstall
  });
});
