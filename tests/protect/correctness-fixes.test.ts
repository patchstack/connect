import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { _testExports } from '../../src/protect/engine/engine.js';

const { isInternalHost } = _testExports as { isInternalHost: (h: string) => boolean };

// Regression tests for three output-filtering / egress correctness fixes.

describe('isInternalHost — IPv6 ULA (fc/fd) must not over-match hostnames', () => {
  it('classifies real IPv6 unique-local addresses as internal', () => {
    expect(isInternalHost('fc00::1')).toBe(true);
    expect(isInternalHost('fd12:3456:789a:1::1')).toBe(true);
    expect(isInternalHost('fe80::1')).toBe(true);
  });

  it('does NOT classify ordinary hostnames that merely start with fc/fd as internal', () => {
    expect(isInternalHost('fcm.googleapis.com')).toBe(false); // Firebase Cloud Messaging
    expect(isInternalHost('fd-cdn.example.net')).toBe(false);
    expect(isInternalHost('fastly.example.com')).toBe(false);
  });
});

describe('response redaction — contains/stripos must mask case-insensitively', () => {
  it('masks a lowercase leak matched by an upper-case contains rule', async () => {
    const rule = {
      phase: 'response',
      category: 'x',
      action: 'redact',
      rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'SECRET' } }],
    };
    const p: any = await createProtection({
      rules: { firewall: [], whitelists: [], whitelist_keys: {} },
      responseRules: [rule],
      mode: 'block',
    });
    const out = await p.screenResponse(
      new Response('leaked secret value', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const text = await out.text();
    // Detection is case-insensitive; before the fix the mask was case-sensitive, so the lowercase
    // "secret" was reported redacted but served in the clear.
    expect(/secret/i.test(text)).toBe(false);
    expect(text).not.toBe('leaked secret value');
  });
});

describe('egress fetch — redirects are re-screened', () => {
  it('blocks a 3xx whose Location points at an internal host', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('169.254.169.254')) return new Response('metadata'); // must never be reached
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
    }) as any;
    const p: any = await createProtection({ egress: true, mode: 'block', allowHosts: [] });
    try {
      let blocked = false;
      try {
        await globalThis.fetch('http://93.184.216.34/'); // allowed external IP → 302 → internal
      } catch (e) {
        blocked = /Patchstack blocked/.test(String(e));
      }
      expect(blocked).toBe(true);
    } finally {
      p.uninstallEgress?.();
      globalThis.fetch = origFetch;
    }
  });

  it('follows a redirect to an allowed host and returns the final response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/final')) return new Response('final-body');
      return new Response(null, { status: 302, headers: { location: 'http://93.184.216.34/final' } });
    }) as any;
    const p: any = await createProtection({ egress: true, mode: 'block', allowHosts: [] });
    try {
      const res = await globalThis.fetch('http://93.184.216.34/start');
      expect(await res.text()).toBe('final-body');
    } finally {
      p.uninstallEgress?.();
      globalThis.fetch = origFetch;
    }
  });
});
