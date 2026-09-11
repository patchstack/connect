import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildManifestBody,
  canRetryManifestPost,
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

/**
 * A validation refusal in the shape the API uses: a sentence for people, and an `errors` object keyed by
 * the refused field. Synthetic — the wording is invented here, because the code must not depend on it.
 */
const refusal = (field: string) =>
  new Response(JSON.stringify({ message: 'Refused.', errors: { [field]: ['Refused.'] } }), { status: 422 });

const validationError = (fields: string[], message = 'Refused.'): PatchstackError => {
  const err = new PatchstackError(message, 'VALIDATION_ERROR');
  err.fields = fields;
  return err;
};

describe('environmentRejected', () => {
  it('recognises a refusal that names the environment field', () => {
    expect(environmentRejected(validationError(['environment']))).toBe(true);
    expect(environmentRejected(validationError(['packages', 'environment']))).toBe(true);
  });

  it('decides on the field named, never on the wording', () => {
    // A sentence that mentions the environment while refusing a different field is not this case.
    expect(environmentRejected(validationError(['packages'], 'The environment looks fine; packages do not.'))).toBe(false);
    // A refusal that names no field at all is a real refusal.
    expect(environmentRejected(validationError([], 'The selected environment is invalid.'))).toBe(false);
  });

  it('ignores anything that is not a validation refusal', () => {
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

  it('reports as sandbox to a server that refuses local, and says which label was used', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(refusal('environment')).mockResolvedValueOnce(accepted());
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

  it('does not fall back for a refusal of any other field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(refusal('packages')));

    await expect(
      postManifestWithEnvironmentFallback({ ...config, environment: 'local' } as Config, payload),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', fields: ['packages'] });
  });

  it('does not fall back for a refusal that names no field, whatever it says', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'The selected environment is invalid.' }), { status: 422 }),
      ),
    );

    await expect(
      postManifestWithEnvironmentFallback({ ...config, environment: 'local' } as Config, payload),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', fields: [] });
  });

  it('never rewrites a production or sandbox label', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(refusal('environment')));

    await expect(postManifestWithEnvironmentFallback(config, payload)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('canRetryManifestPost', () => {
  it('allows a retry only for a site that already exists', () => {
    expect(canRetryManifestPost(config)).toBe(true);
    // The first post provisions the site and has no idempotency key; a retry could provision twice.
    expect(canRetryManifestPost({ ...config, siteUuid: null } as Config)).toBe(false);
  });
});
