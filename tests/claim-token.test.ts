import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CLAIM_TOKEN_HEADER, claimOutcomeLines, claimTokenHeader, postManifest } from '../src/client.js';
import { persistApiKey, persistSiteUuid, resolveConfig } from '../src/config.js';
import type { Config, ManifestClaimOutcome } from '../src/types.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function config(overrides: Partial<Config> = {}): Config {
  return {
    siteUuid: null,
    apiKey: null,
    pulseAuth: null,
    endpoint: 'https://example.com/monitor/pulse/manifest',
    timeoutMs: 30_000,
    environment: 'production',
    widget: true,
    ...overrides,
  };
}

const manifest = { ecosystem: 'npm' as const, packages: [{ name: 'lodash', version: '4.17.21' }] };

describe('the claim token in configuration', () => {
  let cwd: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-claim-'));
    delete process.env.PATCHSTACK_CLAIM_TOKEN;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(cwd, { recursive: true, force: true });
  });

  it('is absent unless somebody passes one', async () => {
    expect((await resolveConfig({ cwd })).claimToken).toBeNull();
  });

  it('comes from the environment', async () => {
    process.env.PATCHSTACK_CLAIM_TOKEN = 'from-env';
    expect((await resolveConfig({ cwd })).claimToken).toBe('from-env');
  });

  it('prefers the command line over the environment', async () => {
    process.env.PATCHSTACK_CLAIM_TOKEN = 'from-env';
    expect((await resolveConfig({ cwd, cliClaimToken: 'from-flag' })).claimToken).toBe('from-flag');
  });

  it('treats a blank value as none', async () => {
    process.env.PATCHSTACK_CLAIM_TOKEN = '   ';
    expect((await resolveConfig({ cwd, cliClaimToken: '' })).claimToken).toBeNull();
  });

  it('is never written to the project, whichever file the connector persists', async () => {
    process.env.PATCHSTACK_CLAIM_TOKEN = 'from-env';
    await resolveConfig({ cwd, cliClaimToken: 'from-flag' });

    await persistSiteUuid(cwd, VALID_UUID);
    await persistApiKey(cwd, 'secret-987');

    const committed = await readFile(path.join(cwd, '.patchstackrc.json'), 'utf8');
    const local = await readFile(path.join(cwd, '.patchstackrc.local.json'), 'utf8');
    expect(committed).not.toContain('from-flag');
    expect(committed).not.toContain('from-env');
    expect(local).not.toContain('from-flag');
    expect(local).not.toContain('from-env');
  });
});

describe('the claim token on the wire', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rides as a header when configured, and the body stays what --dry-run prints', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ uuid: VALID_UUID, stored: true, claim: { state: 'claimed' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await postManifest(config({ claimToken: 'tok-123' }), manifest);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)[CLAIM_TOKEN_HEADER]).toBe('tok-123');
    expect(init.body as string).not.toContain('tok-123');
    expect(result.claim).toEqual({ state: 'claimed' });
  });

  it('sends no such header without one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ uuid: VALID_UUID, stored: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await postManifest(config(), manifest);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers as Record<string, string>).not.toHaveProperty(CLAIM_TOKEN_HEADER);
  });

  it('does not prepare the header for an unconfirmed project endpoint', () => {
    expect(claimTokenHeader(config({ claimToken: 'tok-123', endpointTrusted: false }))).toEqual({});
  });
});

describe('what the person is told about the claim token', () => {
  it('says nothing when none was passed', () => {
    expect(claimOutcomeLines({ state: 'claimed' }, config())).toEqual([]);
    expect(claimOutcomeLines(undefined, config())).toEqual([]);
  });

  it('names the dashboard when the site landed in the account, and tells a re-run apart', () => {
    const claimed = claimOutcomeLines(
      { state: 'claimed', site_id: 7, dashboard_url: 'https://app.example.com/site/7/monitoring' },
      config({ claimToken: 'tok' }),
    );
    expect(claimed[0]).toMatch(/connected to your patchstack account/i);
    expect(claimed).toContain('Dashboard: https://app.example.com/site/7/monitoring');
    expect(claimOutcomeLines({ state: 'owned-by-you' }, config({ claimToken: 'tok' }))[0]).toMatch(/already connected/i);
  });

  it('says why the site is not connected, and points at the link — even when the server said nothing', () => {
    const cases: [ManifestClaimOutcome | undefined, RegExp][] = [
      [{ state: 'owned-by-other' }, /different patchstack account/i],
      [{ state: 'rejected', reason: 'expired' }, /expired/i],
      [{ state: 'rejected', reason: 'invalid' }, /did not recognise/i],
      [undefined, /did not act/i],
    ];
    for (const [claim, why] of cases) {
      const lines = claimOutcomeLines(claim, config({ claimToken: 'tok' }));
      expect(lines[0]).toMatch(/^Not connected to your account/);
      expect(lines[0]).toMatch(why);
      expect(lines.join(' ')).toMatch(/dashboard link/i);
    }
  });
});
