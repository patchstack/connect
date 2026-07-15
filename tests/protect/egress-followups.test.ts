import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// Egress hardening follow-ups: IPv6 host handling on the node:http path (#2), WebSocket
// screening (#6), and the allowHosts allowlist overriding an internal-host block (#9).

async function withEgress(opts: any, fn: (p: any) => Promise<void>) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('stub')) as any;
  const p: any = await createProtection({ egress: true, mode: 'block', ...opts });
  try {
    await fn(p);
  } finally {
    p.uninstallEgress?.();
    globalThis.fetch = origFetch;
  }
}

async function nodeHttp() {
  const ns: any = await import('node:http');
  return ns.default ?? ns;
}

describe('egress — node:http IPv6 hosts (#2)', () => {
  it('blocks IPv6 loopback given as options host/hostname (not just as a URL)', async () => {
    await withEgress({ allowHosts: [] }, async () => {
      const http = await nodeHttp();
      const throws = (fn: () => void) => {
        try {
          fn();
          return false;
        } catch (e) {
          return /Patchstack blocked/.test(String(e));
        }
      };
      expect(throws(() => http.request('http://[::1]/'))).toBe(true); // URL form
      expect(throws(() => http.request({ host: '::1', path: '/' }))).toBe(true); // bare ::1
      expect(throws(() => http.request({ hostname: '[::1]', port: 8080, path: '/' }))).toBe(true); // bracketed + port
    });
  });
});

describe('egress — WebSocket screening (#6)', () => {
  it('blocks a ws:// connection to an internal host and restores the global on uninstall', async () => {
    if (typeof globalThis.WebSocket !== 'function') return; // runtime without global WebSocket
    await withEgress({ allowHosts: [] }, async () => {
      let blocked = false;
      try {
        // eslint-disable-next-line no-new
        new WebSocket('ws://169.254.169.254/');
      } catch (e) {
        blocked = /Patchstack blocked/.test(String(e));
      }
      expect(blocked).toBe(true);
    });
    // After uninstall the guard marker is gone (global restored).
    expect((globalThis.WebSocket as any)?.__patchstackGuarded).toBeUndefined();
  });
});

describe('egress — allowHosts overrides an internal block (#9)', () => {
  it('permits a normally-internal host that is explicitly allowlisted', async () => {
    await withEgress({ allowHosts: ['169.254.169.254'] }, async () => {
      const res = await globalThis.fetch('http://169.254.169.254/latest/meta-data/');
      expect(await res.text()).toBe('stub'); // allowed → reached the stubbed fetch
    });
  });
});
