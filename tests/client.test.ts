import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEndpointUrl, postManifest } from '../src/client.js';
import { PatchstackError } from '../src/types.js';

describe('buildEndpointUrl', () => {
  it('joins base and uuid cleanly', () => {
    expect(buildEndpointUrl('http://api.patchstack.com/monitor/pulse/manifest', 'abc')).toBe(
      'http://api.patchstack.com/monitor/pulse/manifest/abc',
    );
  });

  it('strips a trailing slash on the base', () => {
    expect(buildEndpointUrl('https://example.com/x/', 'abc')).toBe('https://example.com/x/abc');
  });

  it('url-encodes the uuid', () => {
    expect(buildEndpointUrl('https://example.com', 'a b')).toBe('https://example.com/a%20b');
  });

  it('returns the bare base when no uuid is provided', () => {
    expect(buildEndpointUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(buildEndpointUrl('https://example.com/x', null)).toBe('https://example.com/x');
    expect(buildEndpointUrl('https://example.com/x', '')).toBe('https://example.com/x');
  });
});

describe('postManifest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed JSON body on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ stored: true, manifest_id: 1, checksum: 'abc123abc123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await postManifest(
      { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 30_000 },
      { ecosystem: 'npm', packages: [{ name: 'lodash', version: '4.17.21' }] },
    );
    expect(result.stored).toBe(true);
    expect(result.manifest_id).toBe(1);
  });

  it('throws SITE_NOT_FOUND on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Site not found.' }), { status: 404 }),
      ),
    );

    await expect(
      postManifest(
        { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 30_000 },
        { ecosystem: 'npm', packages: [] },
      ),
    ).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
  });

  it('throws VALIDATION_ERROR on 422', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'The packages field is required.' }), {
          status: 422,
        }),
      ),
    );

    await expect(
      postManifest(
        { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 30_000 },
        { ecosystem: 'npm', packages: [] },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws NETWORK_ERROR if fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

    await expect(
      postManifest(
        { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 30_000 },
        { ecosystem: 'npm', packages: [] },
      ),
    ).rejects.toBeInstanceOf(PatchstackError);
  });

  it('passes an AbortSignal with the configured timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ stored: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await postManifest(
      { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 12345 },
      { ecosystem: 'npm', packages: [] },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('posts to the bare endpoint when siteUuid is null and returns the uuid the server assigns', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ uuid: 'cc02a05b-b7db-41b9-bd81-bfcebb09f84a', stored: true, manifest_id: 1, checksum: 'abc123abc123' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await postManifest(
      { siteUuid: null, endpoint: 'https://example.com/monitor/pulse/manifest', timeoutMs: 30_000 },
      { ecosystem: 'npm', packages: [{ name: 'lodash', version: '4.17.21' }] },
    );

    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://example.com/monitor/pulse/manifest');
    expect(result.uuid).toBe('cc02a05b-b7db-41b9-bd81-bfcebb09f84a');
    expect(result.stored).toBe(true);
  });

  it('maps a TimeoutError to NETWORK_TIMEOUT', async () => {
    const timeoutErr = new Error('Aborted');
    timeoutErr.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));

    await expect(
      postManifest(
        { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 1 },
        { ecosystem: 'npm', packages: [] },
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
  });
});
