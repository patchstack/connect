import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildClaimUrl,
  buildEndpointUrl,
  buildRulesUrl,
  buildSettingsUrl,
  fetchSiteStatus,
  postManifest,
} from '../src/client.js';
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

describe('buildRulesUrl', () => {
  it('maps the production manifest endpoint to the per-site rules endpoint', () => {
    expect(
      buildRulesUrl(
        'https://api.patchstack.com/monitor/pulse/manifest',
        '550e8400-e29b-41d4-a716-446655440000',
      ),
    ).toBe(
      'https://api.patchstack.com/monitor/pulse/rules/550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('preserves custom manifest paths and removes query/hash fragments', () => {
    expect(buildRulesUrl('http://localhost:8000/custom/manifest?x=1#test', 'site/id')).toBe(
      'http://localhost:8000/custom/rules/site%2Fid',
    );
  });
});

describe('buildClaimUrl', () => {
  it('uses the API endpoint origin plus /monitor/claim?site=<uuid>', () => {
    expect(
      buildClaimUrl('https://app.patchstack.com/monitor/pulse/manifest', 'abc-def'),
    ).toBe('https://app.patchstack.com/monitor/claim?site=abc-def');
  });

  it('preserves staging origins (ngrok)', () => {
    expect(
      buildClaimUrl('https://3ad1-18-170-248-162.ngrok-free.app/monitor/pulse/manifest', 'xyz'),
    ).toBe('https://3ad1-18-170-248-162.ngrok-free.app/monitor/claim?site=xyz');
  });

  it('drops the manifest path from the API endpoint', () => {
    expect(
      buildClaimUrl('https://example.com/some/deep/path', 'abc'),
    ).toBe('https://example.com/monitor/claim?site=abc');
  });

  it('handles a trailing slash on the endpoint', () => {
    expect(
      buildClaimUrl('https://example.com/monitor/pulse/manifest/', 'abc'),
    ).toBe('https://example.com/monitor/claim?site=abc');
  });

  it('url-encodes the uuid', () => {
    expect(buildClaimUrl('https://example.com/x', 'a b')).toBe(
      'https://example.com/monitor/claim?site=a%20b',
    );
  });

  it('preserves the scheme (http vs https) of the API endpoint', () => {
    expect(buildClaimUrl('http://localhost:8001/monitor/pulse/manifest', 'abc')).toBe(
      'http://localhost:8001/monitor/claim?site=abc',
    );
  });
});

describe('buildSettingsUrl', () => {
  it('uses the API endpoint origin plus /monitor/widget/settings/<uuid>', () => {
    expect(
      buildSettingsUrl('https://api.patchstack.com/monitor/pulse/manifest', 'abc-def'),
    ).toBe('https://api.patchstack.com/monitor/widget/settings/abc-def');
  });

  it('url-encodes the uuid and preserves staging origins', () => {
    expect(buildSettingsUrl('http://localhost:8001/monitor/pulse/manifest', 'a b')).toBe(
      'http://localhost:8001/monitor/widget/settings/a%20b',
    );
  });
});

describe('fetchSiteStatus', () => {
  const config = {
    siteUuid: 'uuid',
    endpoint: 'https://example.com/monitor/pulse/manifest',
    timeoutMs: 30_000,
    widget: true,
    environment: 'production',
  } as const;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns active on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ settings: {} }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSiteStatus(config)).resolves.toBe('active');
  });

  it('returns removed on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Site not found.' }), { status: 404 }),
      ),
    );

    await expect(fetchSiteStatus(config)).resolves.toBe('removed');
  });

  it('returns unknown on server errors and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    await expect(fetchSiteStatus(config)).resolves.toBe('unknown');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    await expect(fetchSiteStatus(config)).resolves.toBe('unknown');
  });

  it('returns unknown without a request when no siteUuid is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSiteStatus({ ...config, siteUuid: null })).resolves.toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hits the settings URL with a cache-busting param and no-cache header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ settings: {} }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSiteStatus(config);

    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toMatch(
      /^https:\/\/example\.com\/monitor\/widget\/settings\/uuid\?t=\d+$/,
    );
    expect((init.headers as Record<string, string>)['Cache-Control']).toBe('no-cache');
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
      { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 30_000, widget: true, environment: 'production' },
      { ecosystem: 'npm', packages: [{ name: 'lodash', version: '4.17.21' }] },
    );
    expect(result.stored).toBe(true);
    expect(result.manifest_id).toBe(1);
  });

  it('sends the configured environment in the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ stored: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await postManifest(
      { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 30_000, widget: true, environment: 'sandbox' },
      { ecosystem: 'npm', packages: [{ name: 'lodash', version: '4.17.21' }] },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { environment: string; ecosystem: string };
    expect(body.environment).toBe('sandbox');
    expect(body.ecosystem).toBe('npm');
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
        { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 30_000, widget: true, environment: 'production' },
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
        { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 30_000, widget: true, environment: 'production' },
        { ecosystem: 'npm', packages: [] },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws NETWORK_ERROR if fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

    await expect(
      postManifest(
        { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 30_000, widget: true, environment: 'production' },
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
      { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 12345, widget: true, environment: 'production' },
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
      { siteUuid: null, endpoint: 'https://example.com/monitor/pulse/manifest', timeoutMs: 30_000, widget: true, environment: 'production' },
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
        { siteUuid: 'uuid', endpoint: 'https://example.com', timeoutMs: 1, widget: true, environment: 'production' },
        { ecosystem: 'npm', packages: [] },
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
  });
});
