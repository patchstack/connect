import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { login } from '../src/login.js';
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

      // One credential for both paths. Pulse resolution falls back to apiKey,
      // so a second copy is not written.
      const written = JSON.parse(readFileSync('.patchstackrc.json', 'utf8'));
      expect(written.apiKey).toBe('new-secret-987');
      expect(written.pulseAuth).toBeUndefined();
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
