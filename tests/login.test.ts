import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clearPendingLogin,
  login,
  readPendingLogin,
  redeemIfApproved,
  startLogin,
  waitForApproval,
} from '../src/login.js';
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
  user_code: 'WDJB-MJHT',
  expires_in: 600,
  interval: 5,
};

const noSleep = { sleep: async () => {}, now: () => 0 };

describe('login', () => {
  it('prompts with the code, then persists the rotated credential', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ps-login-'));
    const original = process.cwd();
    process.chdir(cwd);

    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(json(started))
        .mockResolvedValueOnce(json({ api_key: 'new-secret-987' }));
      const onPrompt = vi.fn();

      const result = await login(config(), onPrompt, { fetchImpl: fetchImpl as never, ...noSleep });

      expect(result.status).toBe('approved');
      // The API redirects this to the dashboard SPA; the code rides along so
      // following the link is one confirmation rather than a retype.
      expect(onPrompt).toHaveBeenCalledWith(
        'WDJB-MJHT',
        'https://api.patchstack.com/monitor/pulse/device?code=WDJB-MJHT',
      );

      // The credential file, not the committed config: the config is meant to be committed, so a
      // credential in it is a credential in the repository.
      const written = JSON.parse(readFileSync('.patchstackrc.local.json', 'utf8'));
      expect(written.apiKey).toBe('new-secret-987');
      // One credential for both paths. Pulse resolution falls back to apiKey, so a second copy is not
      // written.
      expect(written.pulseAuth).toBeUndefined();
      // And the project now ignores it. A rotated credential is no less of a secret than a fresh one.
      expect(readFileSync('.gitignore', 'utf8')).toContain('.patchstackrc.local.json');
    } finally {
      process.chdir(original);
    }
  });

  it('keeps polling while the owner has not approved', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(started))
      .mockResolvedValueOnce(json({ error: 'authorization_pending' }, 428))
      .mockResolvedValueOnce(json({ error: 'authorization_pending' }, 428))
      .mockResolvedValueOnce(json({ api_key: 'new-secret-987' }));

    const cwd = await mkdtemp(path.join(tmpdir(), 'ps-login-'));
    const original = process.cwd();
    process.chdir(cwd);

    try {
      const result = await login(config(), vi.fn(), { fetchImpl: fetchImpl as never, ...noSleep });
      expect(result.status).toBe('approved');
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      process.chdir(original);
    }
  });

  it('explains that an unclaimed site has nobody to approve it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: '…' }, 409));

    const result = await login(config(), vi.fn(), { fetchImpl: fetchImpl as never, ...noSleep });

    expect(result.status).toBe('unclaimed');
    expect(result.message).toMatch(/claim/i);
  });

  it('reports an unknown site', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: '…' }, 404));

    expect((await login(config(), vi.fn(), { fetchImpl: fetchImpl as never, ...noSleep })).status).toBe(
      'not-found',
    );
  });

  it('refuses without a site UUID, and never calls the network', async () => {
    const fetchImpl = vi.fn();

    const result = await login(config({ siteUuid: null }), vi.fn(), {
      fetchImpl: fetchImpl as never,
      ...noSleep,
    });

    expect(result.status).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gives up once the code has expired', async () => {
    let clock = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(started))
      .mockResolvedValue(json({ error: 'authorization_pending' }, 428));

    const result = await login(config(), vi.fn(), {
      fetchImpl: fetchImpl as never,
      sleep: async () => {
        clock += 60_000;
      },
      now: () => clock,
    });

    expect(result.status).toBe('expired');
  });
});

/**
 * The two-step shape exists for assistants: they run a command, wait for it to
 * exit, and only then read stdout. A command that blocks for ten minutes shows
 * them nothing until the code has already expired.
 */
describe('start and resume', () => {
  it('returns the link without waiting for approval', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(started));

    const result = await startLogin(config(), { fetchImpl: fetchImpl as never, ...noSleep });

    expect(result.status).toBe('started');
    expect(result.pending?.userCode).toBe('WDJB-MJHT');
    expect(result.pending?.verificationUri).toBe(
      'https://api.patchstack.com/monitor/pulse/device?code=WDJB-MJHT',
    );
    // One call: the code endpoint. Nothing polled.
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('hands the pending request to a later invocation', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(started));
    const cfg = config({ siteUuid: 'resume-uuid' });

    await startLogin(cfg, { fetchImpl: fetchImpl as never, ...noSleep });

    const pending = readPendingLogin('resume-uuid');
    expect(pending?.deviceCode).toBe('device-code');

    clearPendingLogin('resume-uuid');
    expect(readPendingLogin('resume-uuid')).toBeNull();
  });

  it('resumes and persists the credential once approved', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ps-resume-'));
    const original = process.cwd();
    process.chdir(cwd);

    try {
      const start = vi.fn().mockResolvedValueOnce(json(started));
      const cfg = config({ siteUuid: 'resume-2' });
      const begun = await startLogin(cfg, { fetchImpl: start as never, ...noSleep });

      const poll = vi.fn().mockResolvedValueOnce(json({ api_key: 'rotated-987' }));
      const result = await waitForApproval(cfg, begun.pending!, { fetchImpl: poll as never, ...noSleep });

      expect(result.status).toBe('approved');
      expect(JSON.parse(readFileSync('.patchstackrc.local.json', 'utf8')).apiKey).toBe('rotated-987');
      // The pending request is consumed, so a stale --wait cannot re-redeem it.
      expect(readPendingLogin('resume-2')).toBeNull();
    } finally {
      process.chdir(original);
    }
  });

  it('reports an unclaimed site without leaving anything pending', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: '…' }, 409));

    const result = await startLogin(config({ siteUuid: 'unclaimed-1' }), {
      fetchImpl: fetchImpl as never,
      ...noSleep,
    });

    expect(result.status).toBe('unclaimed');
    expect(readPendingLogin('unclaimed-1')).toBeNull();
  });
});

describe('redeemIfApproved', () => {
  it('finishes the flow when the owner has approved', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'ps-redeem-'));
    const original = process.cwd();
    process.chdir(cwd);

    try {
      const cfg = config({ siteUuid: 'redeem-1' });
      const begun = await startLogin(cfg, {
        fetchImpl: vi.fn().mockResolvedValueOnce(json(started)) as never,
        ...noSleep,
      });

      const outcome = await redeemIfApproved(cfg, begun.pending!, {
        fetchImpl: vi.fn().mockResolvedValueOnce(json({ api_key: 'restored-42' })) as never,
      });

      expect(outcome).toBe('approved');
      expect(JSON.parse(readFileSync('.patchstackrc.local.json', 'utf8')).apiKey).toBe('restored-42');
    } finally {
      process.chdir(original);
    }
  });

  it('reports pending without consuming the request, so the link stays valid', async () => {
    const cfg = config({ siteUuid: 'redeem-2' });
    const begun = await startLogin(cfg, {
      fetchImpl: vi.fn().mockResolvedValueOnce(json(started)) as never,
      ...noSleep,
    });

    const outcome = await redeemIfApproved(cfg, begun.pending!, {
      fetchImpl: vi.fn().mockResolvedValueOnce(json({ error: 'authorization_pending' }, 428)) as never,
    });

    expect(outcome).toBe('pending');
    expect(readPendingLogin('redeem-2')).not.toBeNull();
    clearPendingLogin('redeem-2');
  });

  it('clears an expired request so the next run starts a fresh one', async () => {
    const cfg = config({ siteUuid: 'redeem-3' });
    const begun = await startLogin(cfg, {
      fetchImpl: vi.fn().mockResolvedValueOnce(json(started)) as never,
      ...noSleep,
    });

    const outcome = await redeemIfApproved(cfg, begun.pending!, {
      fetchImpl: vi.fn().mockResolvedValueOnce(json({ error: 'expired_token' }, 400)) as never,
    });

    expect(outcome).toBe('expired');
    expect(readPendingLogin('redeem-3')).toBeNull();
  });
});
