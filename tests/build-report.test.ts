import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildManifestBody, postManifestWithEnvironmentFallback } from '../src/client.js';
import type { Config } from '../src/types.js';

const config = {
  siteUuid: '550e8400-e29b-41d4-a716-446655440000',
  endpoint: 'https://example.com/monitor/pulse/manifest',
  timeoutMs: 30_000,
  widget: true,
  environment: 'production',
  environmentSource: 'platform',
} as unknown as Config;

const payload = { packages: [{ name: 'lodash', version: '4.17.21' }] } as Parameters<typeof buildManifestBody>[1];

describe('the environment label a report carries', () => {
  it('says what decided the label, alongside the label', () => {
    const body = buildManifestBody(config, payload, {});
    expect(body.environment).toBe('production');
    expect(body.environment_source).toBe('platform');
  });

  it('says nothing when nothing declared it', () => {
    const local = { ...config, environment: 'local', environmentSource: null } as Config;
    expect(buildManifestBody(local, payload, {})).not.toHaveProperty('environment_source');
  });
});

describe('what a build reports about the marker', () => {
  it('carries the marker outcome when a stamping pass is reporting', () => {
    expect(buildManifestBody(config, payload, {}, 'stamped').marker).toBe('stamped');
    expect(buildManifestBody(config, payload, {}, 'withheld').marker).toBe('withheld');
  });

  // The absence is the contract: it is what tells the scan ahead of the bundler apart from the
  // stamping pass after it, and the two report the same manifest.
  it('carries no marker from a scan', () => {
    expect(buildManifestBody(config, payload, {})).not.toHaveProperty('marker');
  });
});

describe('postManifestWithEnvironmentFallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the marker on the retry an older server forces', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      // First attempt: a server that does not know the `local` label refuses it by name.
      return bodies.length === 1
        ? new Response(JSON.stringify({ message: 'Refused.', errors: { environment: ['Refused.'] } }), { status: 422 })
        : new Response(JSON.stringify({ stored: false, reason: 'duplicate' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const local = { ...config, environment: 'local', environmentSource: null } as Config;
    const result = await postManifestWithEnvironmentFallback(local, payload, 'withheld');

    expect(result.environmentUsed).toBe('sandbox');
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(JSON.parse(body).marker).toBe('withheld');
    }
  });
});
