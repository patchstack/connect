import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildManifestBody,
  environmentRejected,
  postManifestWithEnvironmentFallback,
} from '../src/client.js';
import { PatchstackError, type Config } from '../src/types.js';

const config = {
  siteUuid: '550e8400-e29b-41d4-a716-446655440000',
  endpoint: 'https://example.com/monitor/pulse/manifest',
  timeoutMs: 30_000,
  widget: true,
  environment: 'production',
} as unknown as Config;

const payload = { packages: [{ name: 'lodash', version: '4.17.21' }] } as Parameters<typeof buildManifestBody>[1];

describe('buildManifestBody hosting', () => {
  it('names the hosting platform of a deployed build, by variable names only', () => {
    const body = buildManifestBody(config, payload, { NETLIFY: 'true', DEPLOY_PRIME_URL: 'https://x.netlify.app' });
    expect(body.hosting).toEqual({ platform: 'netlify', evidence: ['NETLIFY', 'DEPLOY_PRIME_URL'] });
    expect(JSON.stringify(body)).not.toContain('x.netlify.app');
  });

  it('omits hosting when nothing names a platform', () => {
    expect(buildManifestBody(config, payload, { HOME: '/x' })).not.toHaveProperty('hosting');
  });

  it('never reports hosting from a local machine, whatever its shell carries', () => {
    const local = { ...config, environment: 'local' } as Config;
    expect(buildManifestBody(local, payload, { NETLIFY: 'true' })).not.toHaveProperty('hosting');
  });
});

describe('environmentRejected', () => {
  it('recognises a validation refusal of the environment field, and nothing else', () => {
    expect(environmentRejected(new PatchstackError('The selected environment is invalid.', 'VALIDATION_ERROR'))).toBe(true);
    expect(environmentRejected(new PatchstackError('The packages field is required.', 'VALIDATION_ERROR'))).toBe(false);
    expect(environmentRejected(new PatchstackError('environment', 'NETWORK_TIMEOUT'))).toBe(false);
    expect(environmentRejected(new Error('environment'))).toBe(false);
  });
});

describe('postManifestWithEnvironmentFallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const accepted = () =>
    new Response(JSON.stringify({ uuid: config.siteUuid, stored: true, manifest_id: 1, checksum: 'abc' }), {
      status: 200,
    });

  it('reports as sandbox to a server that does not know local, and says which label was used', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'The selected environment is invalid.' }), { status: 422 }),
      )
      .mockResolvedValueOnce(accepted());
    vi.stubGlobal('fetch', fetchMock);

    const result = await postManifestWithEnvironmentFallback({ ...config, environment: 'local' } as Config, payload);

    expect(result.environmentUsed).toBe('sandbox');
    expect(result.response.stored).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).environment).toBe('local');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).environment).toBe('sandbox');
  });

  it('keeps the honest label on a server that accepts it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(accepted());
    vi.stubGlobal('fetch', fetchMock);

    const result = await postManifestWithEnvironmentFallback({ ...config, environment: 'local' } as Config, payload);

    expect(result.environmentUsed).toBe('local');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fall back for any other refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'The packages field is required.' }), { status: 422 }),
      ),
    );

    await expect(
      postManifestWithEnvironmentFallback({ ...config, environment: 'local' } as Config, payload),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('never rewrites a production or sandbox label', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'The selected environment is invalid.' }), { status: 422 }),
      ),
    );

    await expect(postManifestWithEnvironmentFallback(config, payload)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});
