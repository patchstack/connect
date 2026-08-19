import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  buildTokenUrl,
  clearPulseToken,
  getPulseToken,
  parsePulseAuth,
  pulseAuthHeader,
} from '../src/pulse-token.js';
import type { Config } from '../src/types.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    siteUuid: 'a-uuid',
    apiKey: null,
    pulseAuth: 'the-secret-40-chars-long-ish-value-here-987',
    endpoint: 'https://api.patchstack.com/monitor/pulse/manifest',
    timeoutMs: 30_000,
    environment: 'production',
    widget: true,
    ...overrides,
  };
}

function tokenResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

beforeEach(() => clearPulseToken());

describe('buildTokenUrl', () => {
  it('derives the token URL from the manifest endpoint', () => {
    expect(buildTokenUrl('https://api.patchstack.com/monitor/pulse/manifest')).toBe(
      'https://api.patchstack.com/monitor/pulse/token',
    );
  });

  it('honours a self-hosted endpoint override', () => {
    expect(buildTokenUrl('https://staging.example.com/monitor/pulse/manifest')).toBe(
      'https://staging.example.com/monitor/pulse/token',
    );
  });

  it('falls back to the canonical path for an unfamiliar endpoint', () => {
    expect(buildTokenUrl('https://example.com/custom')).toBe(
      'https://example.com/monitor/pulse/token',
    );
  });
});

describe('parsePulseAuth', () => {
  it('splits on the last hyphen', () => {
    expect(parsePulseAuth('abc-def-987')).toEqual({ clientId: '987', clientSecret: 'abc-def' });
  });

  it('rejects a credential with no numeric client id', () => {
    expect(parsePulseAuth('abc-def')).toBeNull();
    expect(parsePulseAuth('no-hyphen-at-end-')).toBeNull();
    expect(parsePulseAuth('-987')).toBeNull();
  });
});

describe('getPulseToken', () => {
  it('exchanges the credential and returns the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse({ access_token: 'tok', expires_in: 3600 }));

    expect(await getPulseToken(config(), fetchImpl as never)).toBe('tok');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.patchstack.com/monitor/pulse/token');
  });

  it('caches the token across calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse({ access_token: 'tok', expires_in: 3600 }));

    await getPulseToken(config(), fetchImpl as never);
    await getPulseToken(config(), fetchImpl as never);

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns null without a credential, and never calls the network', async () => {
    const fetchImpl = vi.fn();

    expect(await getPulseToken(config({ pulseAuth: null }), fetchImpl as never)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null when the exchange is rejected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse({ error: 'invalid_client' }, false));

    expect(await getPulseToken(config(), fetchImpl as never)).toBeNull();
  });

  it('returns null when the network fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));

    expect(await getPulseToken(config(), fetchImpl as never)).toBeNull();
  });
});

describe('pulseAuthHeader', () => {
  it('produces a bearer header when a token is available', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse({ access_token: 'tok', expires_in: 3600 }));

    expect(await pulseAuthHeader(config(), fetchImpl as never)).toEqual({
      Authorization: 'Bearer tok',
    });
  });

  it('produces no header at all when unauthenticated, so the request stays legacy', async () => {
    expect(await pulseAuthHeader(config({ pulseAuth: null }), vi.fn() as never)).toEqual({});
  });
});
