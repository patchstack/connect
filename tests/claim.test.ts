import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  claim,
  clearPendingClaim,
  readPendingClaim,
  redeemClaimIfApproved,
  savePendingClaim,
  startClaim,
  waitForClaim,
} from '../src/claim.js';
import { readPendingLogin, savePendingLogin } from '../src/login.js';
import type { Config } from '../src/types.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    siteUuid: 'a-uuid',
    apiKey: null,
    pulseAuth: null,
    endpoint: 'https://api.patchstack.com/monitor/pulse/manifest',
    timeoutMs: 30_000,
    environment: 'production',
    widget: true,
    ...overrides,
  };
}

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const started = {
  device_code: 'device-code',
  user_code: 'BQDX-7ZKM',
  expires_in: 600,
  interval: 5,
};

const noSleep = { sleep: async () => {}, now: () => 0 };

describe('claim', () => {
  it('prompts with the code, then reports who claimed the site', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(started))
      .mockResolvedValueOnce(json({ account: 'danilo@example.test' }));
    const onPrompt = vi.fn();

    const result = await claim(config(), onPrompt, { fetchImpl: fetchImpl as never, ...noSleep });

    expect(result.status).toBe('claimed');
    expect(result.account).toBe('danilo@example.test');
    // The API redirects this to the dashboard SPA; the code rides along so following the link is one
    // confirmation rather than a retype.
    expect(onPrompt).toHaveBeenCalledWith(
      'BQDX-7ZKM',
      'https://api.patchstack.com/monitor/pulse/device?code=BQDX-7ZKM',
    );
  });

  it('asks for a claim, not a login', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(started));

    await startClaim(config(), { fetchImpl: fetchImpl as never, ...noSleep });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.patchstack.com/monitor/pulse/device/code');
    // The intent is what makes this the mirror image of `login` on the server: the same transport,
    // the opposite requirement on who owns the site.
    expect(JSON.parse(init.body as string)).toEqual({ site_uuid: 'a-uuid', intent: 'claim' });
  });

  it('keeps polling while nobody has claimed it yet', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(started))
      .mockResolvedValueOnce(json({}, 428))
      .mockResolvedValueOnce(json({}, 428))
      .mockResolvedValueOnce(json({ account: 'someone@example.test' }));

    const result = await claim(config(), () => {}, { fetchImpl: fetchImpl as never, ...noSleep });

    expect(result.status).toBe('claimed');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('treats an already-claimed site as a conflict, not a failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({}, 409));

    const result = await claim(config(), () => {}, { fetchImpl: fetchImpl as never, ...noSleep });

    expect(result.status).toBe('already-claimed');
    expect(result.message).toMatch(/already attached/i);
  });

  it('reports an unknown site', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({}, 404));

    const result = await claim(config(), () => {}, { fetchImpl: fetchImpl as never, ...noSleep });

    expect(result.status).toBe('not-found');
  });

  it('refuses without a site UUID, and never calls the network', async () => {
    const fetchImpl = vi.fn();

    const result = await claim(config({ siteUuid: null }), () => {}, {
      fetchImpl: fetchImpl as never,
      ...noSleep,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/scan/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gives up once the code has expired', async () => {
    let clock = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ ...started, expires_in: 10 }))
      .mockResolvedValue(json({}, 428));

    const result = await claim(config(), () => {}, {
      fetchImpl: fetchImpl as never,
      sleep: async () => {
        clock += 5_000;
      },
      now: () => clock,
    });

    expect(result.status).toBe('expired');
  });
});

describe('claiming does not disturb the site credential', () => {
  it('writes nothing when the server issues no credential', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ps-claim-'));
    const original = process.cwd();
    process.chdir(cwd);

    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(json(started))
        .mockResolvedValueOnce(json({ account: 'danilo@example.test' }));

      const result = await claim(config(), () => {}, { fetchImpl: fetchImpl as never, ...noSleep });

      expect(result.credentialSaved).toBe(false);
      // The project already holds a working credential from provisioning. Rotating it here would
      // break CI, deploys and other checkouts for a step that has nothing to do with them.
      expect(existsSync(path.join(cwd, '.patchstackrc.local.json'))).toBe(false);
    } finally {
      process.chdir(original);
    }
  });

  it('persists one when the server does issue it', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ps-claim-'));
    const original = process.cwd();
    process.chdir(cwd);

    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(json(started))
        .mockResolvedValueOnce(json({ account: 'danilo@example.test', api_key: 'issued-123' }));

      const result = await claim(config(), () => {}, { fetchImpl: fetchImpl as never, ...noSleep });

      expect(result.credentialSaved).toBe(true);
      // A claim from a checkout that never had the credential is the case this covers.
      const written = JSON.parse(readFileSync('.patchstackrc.local.json', 'utf8'));
      expect(written.apiKey).toBe('issued-123');
    } finally {
      process.chdir(original);
    }
  });
});

describe('a pending claim', () => {
  it('is handed to a later invocation', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(started));

    const result = await startClaim(config(), { fetchImpl: fetchImpl as never, ...noSleep });

    expect(result.status).toBe('started');
    expect(readPendingClaim('a-uuid')?.userCode).toBe('BQDX-7ZKM');

    clearPendingClaim('a-uuid');
    expect(readPendingClaim('a-uuid')).toBeNull();
  });

  it('does not collide with a pending login for the same site', () => {
    // Two flows against one site are legitimate — a claim can be in flight while a login is not yet
    // approved — and one overwriting the other would redeem the wrong device code.
    savePendingClaim('shared-uuid', {
      deviceCode: 'claim-code',
      userCode: 'CLAI-MMMM',
      verificationUri: 'https://example.test/device?code=CLAI-MMMM',
      expiresAt: 1,
      intervalMs: 5_000,
    });
    savePendingLogin('shared-uuid', {
      deviceCode: 'login-code',
      userCode: 'LOGI-NNNN',
      verificationUri: 'https://example.test/device?code=LOGI-NNNN',
      expiresAt: 1,
      intervalMs: 5_000,
    });

    expect(readPendingClaim('shared-uuid')?.deviceCode).toBe('claim-code');
    expect(readPendingLogin('shared-uuid')?.deviceCode).toBe('login-code');

    clearPendingClaim('shared-uuid');
    expect(readPendingClaim('shared-uuid')).toBeNull();
    // Clearing one leaves the other alone.
    expect(readPendingLogin('shared-uuid')?.deviceCode).toBe('login-code');
  });

  it('finishes the flow when it has been claimed', async () => {
    const pending = {
      deviceCode: 'device-code',
      userCode: 'BQDX-7ZKM',
      verificationUri: 'https://example.test/device?code=BQDX-7ZKM',
      expiresAt: Number.MAX_SAFE_INTEGER,
      intervalMs: 5_000,
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ account: 'danilo@example.test' }));

    const outcome = await redeemClaimIfApproved(config(), pending, {
      fetchImpl: fetchImpl as never,
      ...noSleep,
    });

    expect(outcome).not.toBe('pending');
    expect(outcome === 'pending' ? null : outcome.status).toBe('claimed');
  });

  it('reports pending without consuming the request, so the link stays valid', async () => {
    savePendingClaim('a-uuid', {
      deviceCode: 'device-code',
      userCode: 'BQDX-7ZKM',
      verificationUri: 'https://example.test/device?code=BQDX-7ZKM',
      expiresAt: Number.MAX_SAFE_INTEGER,
      intervalMs: 5_000,
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({}, 428));

    const outcome = await redeemClaimIfApproved(config(), readPendingClaim('a-uuid')!, {
      fetchImpl: fetchImpl as never,
      ...noSleep,
    });

    expect(outcome).toBe('pending');
    expect(readPendingClaim('a-uuid')).not.toBeNull();

    clearPendingClaim('a-uuid');
  });

  it('is cleared once redeemed, so a later run starts a fresh request', async () => {
    savePendingClaim('a-uuid', {
      deviceCode: 'device-code',
      userCode: 'BQDX-7ZKM',
      verificationUri: 'https://example.test/device?code=BQDX-7ZKM',
      expiresAt: Number.MAX_SAFE_INTEGER,
      intervalMs: 5_000,
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ account: 'danilo@example.test' }));

    await waitForClaim(config(), readPendingClaim('a-uuid')!, {
      fetchImpl: fetchImpl as never,
      ...noSleep,
    });

    expect(readPendingClaim('a-uuid')).toBeNull();
  });
});
