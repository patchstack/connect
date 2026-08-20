import { describe, expect, it, vi } from 'vitest';
import { authFailureMessage, postInputMap, postPackageRemoved, postManifest } from '../src/client.js';
import { PatchstackError, type Config } from '../src/types.js';

/**
 * A refusal has to say which of three things went wrong, because each has a different fix.
 *
 * Every Pulse route addressing an existing site requires a credential, so a rejection is the likeliest
 * failure a misconfigured project meets — and `Patchstack returned 401` is the one report that helps
 * nobody. This output is often read by an AI agent with no other source of the answer, so "which setup
 * step did I miss" has to be answerable from the text alone.
 */
const config = (over: Partial<Config> = {}): Config =>
  ({
    endpoint: 'https://api.test/monitor/pulse/manifest',
    siteUuid: '11111111-1111-4111-8111-111111111111',
    apiKey: null,
    pulseAuth: null,
    timeoutMs: 5_000,
    environment: 'production',
    ...over,
  }) as Config;

const WITH_CREDENTIAL = config({ pulseAuth: 'a-secret-40-chars-long-enough-for-this-1' });

const respond = (status: number, body = '{}') =>
  vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } }));

describe('authFailureMessage', () => {
  it('tells an unconfigured project to obtain a credential', () => {
    const said = authFailureMessage(401, config());

    expect(said).toContain('login');
    expect(said).toContain('PATCHSTACK_API_KEY');
  });

  it('distinguishes a rejected credential from a missing one', () => {
    // The distinction 401 cannot make by itself, and the one that decides the remedy: nothing to set up
    // versus something to renew. Asserted as a difference so neither message can drift into the other.
    const missing = authFailureMessage(401, config());
    const rejected = authFailureMessage(401, WITH_CREDENTIAL);

    expect(rejected).not.toBe(missing);
    expect(rejected).toMatch(/expired|revoked/);
    // A removed site also answers 401 on the authenticated routes, so a message that named only expiry
    // would send someone to re-run `login` against a site that no longer exists.
    expect(rejected).toMatch(/no longer exist/);
  });

  it('reads 403 as the wrong site rather than a missing credential', () => {
    const said = authFailureMessage(403, WITH_CREDENTIAL);

    expect(said).toContain('.patchstackrc.json');
    expect(said).not.toMatch(/expired|revoked/);
  });

  it('says nothing about statuses that are not authentication failures', () => {
    // The control. A helper that answered for every status would relabel a 500 or a 422 as an auth
    // problem, which is worse than the bare status code it replaced.
    for (const status of [200, 404, 422, 429, 500, 503]) {
      expect(authFailureMessage(status, WITH_CREDENTIAL), `status ${status}`).toBeNull();
    }
  });
});

describe('the write paths report a refusal in those terms', () => {
  it('map upload fails with the remedy, not the number', async () => {
    vi.stubGlobal('fetch', respond(401));

    const outcome = await postInputMap(config(), { version: 3, endpoints: [] });

    expect(outcome.result).toBe('failed');
    expect(outcome).toHaveProperty('message');
    const message = (outcome as { message: string }).message;
    expect(message).not.toMatch(/^Patchstack returned/);
    expect(message).toContain('login');
  });

  it('manifest push throws UNAUTHORIZED rather than SERVER_ERROR', async () => {
    vi.stubGlobal('fetch', respond(403));

    await expect(postManifest(WITH_CREDENTIAL, { packages: [] } as never)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('still reports a genuine server error as one', async () => {
    // The other half of the control: the auth handling must not have swallowed every failure branch.
    vi.stubGlobal('fetch', respond(500, 'upstream exploded'));

    await expect(postManifest(WITH_CREDENTIAL, { packages: [] } as never)).rejects.toBeInstanceOf(
      PatchstackError,
    );
    await expect(postManifest(WITH_CREDENTIAL, { packages: [] } as never)).rejects.toMatchObject({
      code: 'SERVER_ERROR',
    });
  });
});

describe('a removed site is still reported as removed', () => {
  it('reads 401 on package-removed as "gone" when the site really is gone', async () => {
    // The regression this guards. That route resolves the site FROM the credential, so a deleted site
    // answers 401 rather than 404 — verified against the server. Left unhandled, uninstalling a site
    // that was already deleted in the dashboard would advise re-running `login`.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/widget/settings/')) return new Response('{}', { status: 404 });
      return new Response('{}', { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await postPackageRemoved(WITH_CREDENTIAL);

    expect(outcome.result).toBe('gone');
  });

  it('reports an auth failure when the site is still there', async () => {
    // The control that keeps the branch above honest: 401 must not become a blanket "gone", or a genuine
    // credential problem would read as a site that no longer exists and be silently ignored.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/widget/settings/')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await postPackageRemoved(WITH_CREDENTIAL);

    expect(outcome.result).toBe('failed');
    expect((outcome as { message: string }).message).toMatch(/credential/i);
  });
});
