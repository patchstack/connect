import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPulseToken } from '../../src/pulse-token.js';
import { createLiveReporter, publicOriginOf } from '../../src/protect/live-report.js';

/** A request-shaped object whose headers answer from a plain map (keys lower-cased). */
const req = (url: string, headers: Record<string, string> = {}) =>
  ({ url, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } }) as unknown as Request;

/** A transport that answers the token exchange and records each live report. */
function transport(status = 202) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const target = String(url);
    if (target.endsWith('/token')) {
      return new Response(JSON.stringify({ access_token: 'jwt', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    posts.push({ url: target, body: JSON.parse(String(init.body)) });
    return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
  });
  return { fetchImpl, posts };
}

const reporter = (fetchImpl: unknown, over: Record<string, unknown> = {}) =>
  createLiveReporter({
    siteUuid: '550e8400-e29b-41d4-a716-446655440000',
    pulseAuth: `${'s'.repeat(40)}-7`,
    baseUrl: 'https://x.test/monitor/pulse',
    fetchImpl: fetchImpl as typeof fetch,
    ...over,
  });

describe('createLiveReporter', () => {
  beforeEach(() => clearPulseToken());
  afterEach(() => { clearPulseToken(); vi.restoreAllMocks(); });

  it('reports the serving origin to /live/<uuid> once, then never again for that origin', async () => {
    const { fetchImpl, posts } = transport();
    const r = reporter(fetchImpl);

    await r.note('https://my-app.example.com');
    await r.note('https://my-app.example.com');

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://x.test/monitor/pulse/live/550e8400-e29b-41d4-a716-446655440000');
    expect(posts[0].body).toEqual({ origin: 'https://my-app.example.com' });
  });

  it('includes the build checksum when given one', async () => {
    const { fetchImpl, posts } = transport();
    await reporter(fetchImpl).note('https://my-app.example.com', '42a12620d1ab');
    expect(posts[0].body).toEqual({ origin: 'https://my-app.example.com', checksum: '42a12620d1ab' });
  });

  it('does nothing without a credential or a site', async () => {
    const { fetchImpl, posts } = transport();
    await createLiveReporter({ siteUuid: '', pulseAuth: 'x', fetchImpl: fetchImpl as typeof fetch }).note('https://a.test');
    await createLiveReporter({ siteUuid: 'u', pulseAuth: '', fetchImpl: fetchImpl as typeof fetch }).note('https://a.test');
    expect(posts).toHaveLength(0);
  });

  it('skips local/loopback origins', async () => {
    const { fetchImpl, posts } = transport();
    const r = reporter(fetchImpl);
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://app.local']) await r.note(origin);
    expect(posts).toHaveLength(0);
  });

  it('retries on a later call after a failed delivery, not on every call', async () => {
    const { fetchImpl, posts } = transport(503);
    const r = reporter(fetchImpl);
    await r.note('https://my-app.example.com'); // fails (503), sets a cooldown
    await r.note('https://my-app.example.com'); // within cooldown → no attempt
    expect(posts).toHaveLength(1);
  });
});

describe('publicOriginOf', () => {
  it('uses request.url when there is no proxy in front', () => {
    expect(publicOriginOf(req('https://my-app.example.com/path?q=1'))).toBe('https://my-app.example.com');
  });

  it('prefers the forwarded host over an internal request.url (a reverse-proxied SSR deploy)', () => {
    // What a React Router server behind a proxy that does not trust `X-Forwarded-*` sees: the app bound a
    // loopback port, while the address the visitor used rides the forwarded headers the proxy set.
    const request = new Request('http://127.0.0.1:8080/', {
      headers: { 'x-forwarded-host': 'lifestyle-886500.hostingersite.com', 'x-forwarded-proto': 'https' },
    });
    expect(publicOriginOf(request)).toBe('https://lifestyle-886500.hostingersite.com');
  });

  it('takes the client-most value of a forwarded-host chain and defaults the scheme to https', () => {
    expect(publicOriginOf(req('http://10.0.0.5/', { 'x-forwarded-host': 'app.example.com, internal-lb' })))
      .toBe('https://app.example.com');
  });

  it('reads an RFC 7239 Forwarded header when that is what the proxy sets', () => {
    expect(publicOriginOf(req('http://127.0.0.1/', { forwarded: 'for=203.0.113.1;host=shop.example.com;proto=https' })))
      .toBe('https://shop.example.com');
  });

  it('falls back to the Host header when no forwarded host is present', () => {
    expect(publicOriginOf(req('http://127.0.0.1:3000/', { host: 'published.example.com' })))
      .toBe('http://published.example.com');
  });

  it('falls back to request.url when the request carries no usable headers', () => {
    expect(publicOriginOf({ url: 'https://plain.example.com/' } as unknown as Request)).toBe('https://plain.example.com');
  });

  it('still yields a loopback origin the reporter then skips, rather than inventing one', () => {
    // publicOriginOf names what it sees; isLocalHost in note() is what refuses to report it.
    expect(publicOriginOf(req('http://localhost:3000/'))).toBe('http://localhost:3000');
  });
});
