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

describe('egress fetch — redirect semantics', () => {
  const withStub = async (stub: (req: Request) => Response | Promise<Response>, fn: () => Promise<void>) => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => stub(new Request(input, init))) as any;
    const p: any = await createProtection({ egress: true, mode: 'block', allowHosts: [] });
    try {
      await fn();
    } finally {
      p.uninstallEgress?.();
      globalThis.fetch = origFetch;
    }
  };

  it('preserves method and body across a 307 redirect', async () => {
    const seen: Array<{ url: string; method: string; body: string | null }> = [];
    await withStub(
      async (req) => {
        const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.clone().text().catch(() => null);
        seen.push({ url: req.url, method: req.method, body });
        if (req.url.includes('/final')) return new Response('ok');
        return new Response(null, { status: 307, headers: { location: 'http://93.184.216.34/final' } });
      },
      async () => {
        await globalThis.fetch('http://93.184.216.34/start', { method: 'POST', body: 'payload' });
        const final = seen.find((s) => s.url.includes('/final'))!;
        expect(final.method).toBe('POST');
        expect(final.body).toBe('payload');
      },
    );
  });

  it('rewrites a 303 redirect to a bodyless GET', async () => {
    const seen: Array<{ url: string; method: string; body: string | null }> = [];
    await withStub(
      async (req) => {
        const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.clone().text().catch(() => null);
        seen.push({ url: req.url, method: req.method, body });
        if (req.url.includes('/final')) return new Response('ok');
        return new Response(null, { status: 303, headers: { location: 'http://93.184.216.34/final' } });
      },
      async () => {
        await globalThis.fetch('http://93.184.216.34/start', { method: 'POST', body: 'payload' });
        const final = seen.find((s) => s.url.includes('/final'))!;
        expect(final.method).toBe('GET');
        expect(final.body).toBeNull();
      },
    );
  });

  it('strips Authorization on a cross-origin redirect hop', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    await withStub(
      async (req) => {
        seen.push({ url: req.url, auth: req.headers.get('authorization') });
        if (req.url.includes('216.35')) return new Response('ok'); // cross-origin target
        return new Response(null, { status: 302, headers: { location: 'http://93.184.216.35/x' } });
      },
      async () => {
        await globalThis.fetch('http://93.184.216.34/start', { headers: { authorization: 'Bearer t0ken' } });
        expect(seen.find((s) => s.url.includes('216.34'))!.auth).toBe('Bearer t0ken'); // kept on initial
        expect(seen.find((s) => s.url.includes('216.35'))!.auth).toBeNull(); // stripped cross-origin
      },
    );
  });

  it('throws after too many redirects', async () => {
    await withStub(
      async () => new Response(null, { status: 302, headers: { location: 'http://93.184.216.34/loop' } }),
      async () => {
        await expect(globalThis.fetch('http://93.184.216.34/start')).rejects.toThrow(/too many redirects/);
      },
    );
  });

  it('does not follow redirects when the caller sets redirect: manual', async () => {
    await withStub(
      async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
      async () => {
        const res = await globalThis.fetch('http://93.184.216.34/start', { redirect: 'manual' });
        expect(res.status).toBe(302); // handed back raw; internal Location NOT followed/screened
      },
    );
  });
});

describe('isInternalHost + redaction — extra edge cases', () => {
  it('classifies uppercase / bracketed IPv6 ULA as internal', () => {
    expect(isInternalHost('FC00::1')).toBe(true);
    expect(isInternalHost('[fd00::1]')).toBe(true);
  });

  it('does not misclassify fe/fd hostnames', () => {
    expect(isInternalHost('fedex.example.com')).toBe(false);
    expect(isInternalHost('fd00shop.example.com')).toBe(false);
  });

  it('masks a case-insensitively matched secret in the body AND a response header', async () => {
    const rule = {
      phase: 'response',
      category: 'x',
      action: 'redact',
      rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'TOPSECRET' } }],
    };
    const p: any = await createProtection({
      rules: { firewall: [], whitelists: [], whitelist_keys: {} },
      responseRules: [rule],
      mode: 'block',
    });
    const resp = new Response('topsecret in body', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'x-leak': 'topsecret in header' },
    });
    const out = await p.screenResponse(resp);
    expect((await out.text()).includes('topsecret')).toBe(false);
    expect(out.headers.get('x-leak')?.includes('topsecret')).toBe(false);
  });
});
