import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistApiKey, SECRET_CONFIG_FILENAME } from '../../src/config.js';
import { clearPulseToken } from '../../src/pulse-token.js';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * From the file setup writes to an authenticated rules request.
 *
 * Setup and the runtime are separate programs that agree on a filename. Splitting the credential out of
 * the committed config moved that filename, and a runtime still reading the old one is silent about it:
 * the rules fetch goes out unauthenticated, the platform refuses it, the guard falls back to bundled or
 * cached rules and keeps screening every request. An app frozen at the rules it installed with looks
 * exactly like a current one.
 *
 * So the chain is asserted end to end, through the real writer, rather than either half in isolation.
 */
const CREDENTIAL = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6-991';

const dirs: string[] = [];
const stopped: Array<{ stop: () => void }> = [];

interface Seen {
  tokenPosts: number;
  ruleAuth: Array<string | null>;
}

/** Serve the token exchange, record what the rules GET carried, and never touch the network. */
function stubTransport(): Seen {
  const seen: Seen = { tokenPosts: 0, ruleAuth: [] };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String((input as { url?: string })?.url ?? input);
      const headers = new Headers(init?.headers ?? {});

      if ((init?.method ?? 'GET').toUpperCase() === 'POST' && /token/i.test(url)) {
        seen.tokenPosts++;

        return new Response(JSON.stringify({ access_token: 'issued-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      seen.ruleAuth.push(headers.get('authorization'));

      return new Response(JSON.stringify({ firewall: [], whitelists: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );

  return seen;
}

beforeEach(() => {
  clearPulseToken();
});

afterEach(() => {
  for (const protection of stopped.splice(0)) protection.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  clearPulseToken();
  clearCredentialEnv();
});

const CREDENTIAL_ENV = ['PATCHSTACK_API_KEY', 'PATCHSTACK_PULSE_AUTH'] as const;

function clearCredentialEnv(): void {
  for (const key of CREDENTIAL_ENV) delete process.env[key];
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-credential-chain-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }));

  return dir;
}

async function boot(cwd: string) {
  const protection = await createProtection({ siteUuid: 'site-under-test', cwd, cacheDir: join(cwd, '.patchstack') });
  stopped.push(protection);

  return protection;
}

describe('the credential setup persisted', () => {
  it('authenticates the rules request', async () => {
    // The whole point of the split: the file the writer chose has to be the file the reader opens.
    clearCredentialEnv();
    const cwd = project();
    const written = await persistApiKey(cwd, CREDENTIAL);
    expect(written.path).toContain(SECRET_CONFIG_FILENAME);
    // And the project really ignores it, verified rather than assumed.
    expect(written.ignored).toBe(true);
    // And it really is in that file, not the committed one.
    expect(readFileSync(join(cwd, SECRET_CONFIG_FILENAME), 'utf8')).toContain(CREDENTIAL);

    const seen = stubTransport();
    await boot(cwd);

    expect(seen.tokenPosts, 'the credential was exchanged for a token').toBeGreaterThan(0);
    expect(seen.ruleAuth, 'a rules request was made').not.toHaveLength(0);
    expect(seen.ruleAuth.every((value) => value === 'Bearer issued-token')).toBe(true);
  });

  it('is still read from the committed file by an install that predates the split', async () => {
    // Upgrading the package must not un-authenticate a guard whose credential is where the older setup
    // put it. Losing live rules on upgrade would be worse than the warning the committed file earns.
    clearCredentialEnv();
    const cwd = project();
    writeFileSync(
      join(cwd, '.patchstackrc.json'),
      JSON.stringify({ siteUuid: 'site-under-test', apiKey: CREDENTIAL }),
    );

    const seen = stubTransport();
    await boot(cwd);

    expect(seen.tokenPosts).toBeGreaterThan(0);
    expect(seen.ruleAuth.every((value) => value === 'Bearer issued-token')).toBe(true);
  });

  it('is not invented when neither file has one', async () => {
    // The control. Without it both assertions above would also hold for a runtime that authenticates
    // every request with something, which is a test that cannot fail for the right reason.
    clearCredentialEnv();
    const cwd = project();

    const seen = stubTransport();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await boot(cwd);

    expect(seen.tokenPosts).toBe(0);
    expect(seen.ruleAuth.every((value) => value === null)).toBe(true);
  });

  it('prefers the local file when both hold one', async () => {
    // `persistApiKey` strips the credential from the committed file, so the two disagree only after a
    // rotation somebody applied by hand. The current one is the one setup writes.
    clearCredentialEnv();
    const cwd = project();
    writeFileSync(
      join(cwd, '.patchstackrc.json'),
      JSON.stringify({ siteUuid: 'site-under-test', apiKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-111' }),
    );
    writeFileSync(join(cwd, SECRET_CONFIG_FILENAME), JSON.stringify({ apiKey: CREDENTIAL }));

    const seen = stubTransport();
    await boot(cwd);

    const exchanged = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String((call[1] as RequestInit | undefined)?.body ?? ''))
      .join(' ');
    expect(exchanged).toContain('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
    expect(exchanged).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(seen.ruleAuth.every((value) => value === 'Bearer issued-token')).toBe(true);
  });
});
