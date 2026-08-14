import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInputMapUrl, postInputMap } from '../src/client.js';
import type { Config } from '../src/types.js';

// Uploading the attack surface is the one path that sends anything derived from source code, so the
// contract is narrow: it goes nowhere without an explicit flag (covered in the CLI), it never throws
// (this runs inside someone's build), and "unchanged" is a real outcome rather than a failure.
const config = (overrides: Partial<Config> = {}): Config =>
  ({
    endpoint: 'https://api.patchstack.com/monitor/pulse/manifest',
    siteUuid: 'aaaa-bbbb',
    timeoutMs: 5_000,
    ...overrides,
  }) as Config;

const map = { version: 3, endpoints: [{ file: 'src/server.ts' }] };

afterEach(() => vi.unstubAllGlobals());

describe('buildInputMapUrl', () => {
  it('derives the sibling ingest path from a manifest endpoint', () => {
    expect(buildInputMapUrl('https://api.patchstack.com/monitor/pulse/manifest', 'abc')).toBe(
      'https://api.patchstack.com/monitor/pulse/input-map/abc',
    );
  });

  it('keeps a staging/tunnel origin — the same reason the rules URL does', () => {
    expect(buildInputMapUrl('http://127.0.0.1:8080/monitor/pulse/manifest', 'abc')).toBe(
      'http://127.0.0.1:8080/monitor/pulse/input-map/abc',
    );
  });

  it('falls back to the canonical path when the endpoint is not a manifest URL', () => {
    expect(buildInputMapUrl('https://example.com/custom', 'abc')).toBe(
      'https://example.com/monitor/pulse/input-map/abc',
    );
  });

  it('url-encodes the uuid', () => {
    expect(buildInputMapUrl('https://example.com/monitor/pulse/manifest', 'a b')).toBe(
      'https://example.com/monitor/pulse/input-map/a%20b',
    );
  });
});

describe('postInputMap', () => {
  it('reports the revision the server stored', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: 'stored', revision: 4 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(postInputMap(config(), map)).resolves.toEqual({ result: 'stored', revision: 4 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.patchstack.com/monitor/pulse/input-map/aaaa-bbbb');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(map);
  });

  it('treats "unchanged" as a result, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: 'unchanged', revision: 2 }), { status: 200 }),
    ));

    await expect(postInputMap(config(), map)).resolves.toEqual({ result: 'unchanged', revision: 2 });
  });

  it('skips without a site uuid instead of posting to a bare path', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await postInputMap(config({ siteUuid: null }), map);

    expect(outcome).toMatchObject({ result: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the schema mismatch on 422 — one side is out of date, and guessing is worse', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 422 })));

    const outcome = await postInputMap(config(), map);

    expect(outcome.result).toBe('failed');
    expect((outcome as { message: string }).message).toMatch(/does not accept this map schema \(version 3\)/);
  });

  it('reports an unknown site distinctly from a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));

    expect((await postInputMap(config(), map) as { message: string }).message).toMatch(/Site not found/);
  });

  it('never throws when the network fails — a build must not break on our outage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const outcome = await postInputMap(config(), map);

    expect(outcome.result).toBe('failed');
    expect((outcome as { message: string }).message).toMatch(/Could not reach Patchstack/);
  });

  it('never throws when the server returns nonsense', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));

    await expect(postInputMap(config(), map)).resolves.toMatchObject({ result: 'failed' });
  });

  it('rejects a "stored" result with no usable revision instead of reporting revision 0', async () => {
    // "stored, revision 0" is not a state the server can be in. Reporting it would announce a successful
    // upload that cannot be pointed at afterwards — worse than saying the upload failed.
    for (const body of [{ result: 'stored' }, { result: 'stored', revision: 0 }, { result: 'unchanged', revision: 'x' }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
      await expect(postInputMap(config(), map)).resolves.toMatchObject({ result: 'failed' });
    }
  });

  it('reports an unexpected shape rather than inventing a revision', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: 'something-else' }), { status: 200 }),
    ));

    await expect(postInputMap(config(), map)).resolves.toMatchObject({ result: 'failed' });
  });
});
