import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { persistApiKey } from './config.js';
import type { Config } from './types.js';

/**
 * Device authorization flow (RFC 8628) for recovering a lost credential.
 *
 * Split into `startLogin` and `waitForApproval` because the two callers need
 * opposite things. A person at a terminal wants one command that prints a code
 * and blocks. An assistant runs a command, waits for it to exit, and only then
 * reads the output — so a command that blocks for ten minutes shows it nothing
 * until the code has already expired, and looks like a hang.
 *
 * `startLogin` returns immediately with the link. `waitForApproval` polls. The
 * CLI runs both for a terminal and only the first for everything else.
 */

export interface LoginDeps {
  fetchImpl?: typeof fetch;
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PendingLogin {
  /** Redeems the credential once approved. Never printed — it is a secret. */
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
}

export interface StartResult {
  status: 'started' | 'unclaimed' | 'not-found' | 'failed';
  pending?: PendingLogin;
  message?: string;
}

export interface LoginResult {
  status: 'approved' | 'expired' | 'unclaimed' | 'not-found' | 'failed';
  message?: string;
  userCode?: string;
  verificationUri?: string;
}

function baseFrom(manifestEndpoint: string): string {
  const url = new URL(manifestEndpoint);
  const p = url.pathname.replace(/\/$/, '');
  url.pathname = p.endsWith('/manifest') ? p.slice(0, -'/manifest'.length) : '/monitor/pulse';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * Where a pending request waits between the two commands.
 *
 * The temp directory rather than the project: the device code is a secret with
 * a ten-minute life, and nothing that short-lived belongs in a repo where it
 * could be committed. Keyed by site so two projects do not collide.
 */
function pendingPath(siteUuid: string): string {
  const key = createHash('sha256').update(siteUuid).digest('hex').slice(0, 16);
  return path.join(tmpdir(), `patchstack-login-${key}.json`);
}

export function savePendingLogin(siteUuid: string, pending: PendingLogin): void {
  writeFileSync(pendingPath(siteUuid), JSON.stringify(pending), { encoding: 'utf8', mode: 0o600 });
}

export function readPendingLogin(siteUuid: string): PendingLogin | null {
  try {
    return JSON.parse(readFileSync(pendingPath(siteUuid), 'utf8')) as PendingLogin;
  } catch {
    return null; // absent, unreadable, or corrupt — all mean "nothing pending"
  }
}

export function clearPendingLogin(siteUuid: string): void {
  try {
    rmSync(pendingPath(siteUuid));
  } catch {
    /* already gone */
  }
}

/** Ask for a code. Returns as soon as the link is available. */
export async function startLogin(config: Config, deps: LoginDeps = {}): Promise<StartResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());

  if (config.siteUuid === null) {
    return { status: 'failed', message: 'No site UUID configured — run `patchstack-connect scan` first.' };
  }

  const base = baseFrom(config.endpoint);

  const started = await fetchImpl(`${base}/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ site_uuid: config.siteUuid }),
  });

  if (started.status === 409) {
    return {
      status: 'unclaimed',
      message:
        'This site has not been claimed yet, so there is no owner to approve the request. Claim it in the dashboard, or delete .patchstackrc.json to provision a new site.',
    };
  }
  if (started.status === 404) {
    return { status: 'not-found', message: 'Patchstack does not recognise this site UUID.' };
  }
  if (!started.ok) {
    return { status: 'failed', message: `Could not start the login (HTTP ${started.status}).` };
  }

  const body = (await started.json()) as {
    device_code: string;
    user_code: string;
    expires_in: number;
    interval: number;
  };

  const pending: PendingLogin = {
    deviceCode: body.device_code,
    userCode: body.user_code,
    // Points at the API, which redirects to the dashboard SPA — the CLI only
    // knows the API origin, and the approval page lives on the app.
    verificationUri: `${base}/device?code=${encodeURIComponent(body.user_code)}`,
    expiresAt: now() + body.expires_in * 1000,
    intervalMs: Math.max(1, body.interval) * 1000,
  };

  savePendingLogin(config.siteUuid, pending);

  return { status: 'started', pending };
}

/**
 * Redeem a pending request if the owner has already approved it, without
 * waiting. Lets a second `login` finish a flow the first one started, so an
 * assistant that comes back after the user approves does the right thing
 * whether or not it remembers the `--wait` flag.
 */
export async function redeemIfApproved(
  config: Config,
  pending: PendingLogin,
  deps: LoginDeps = {},
): Promise<'approved' | 'pending' | 'expired'> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const polled = await fetchImpl(`${baseFrom(config.endpoint)}/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ device_code: pending.deviceCode }),
  });

  if (polled.status === 428) return 'pending';

  if (!polled.ok) {
    if (config.siteUuid !== null) clearPendingLogin(config.siteUuid);
    return 'expired';
  }

  const { api_key: apiKey } = (await polled.json()) as { api_key?: string };
  if (typeof apiKey !== 'string' || apiKey.length === 0) return 'expired';

  await persistApiKey(process.cwd(), apiKey);
  if (config.siteUuid !== null) clearPendingLogin(config.siteUuid);

  return 'approved';
}

/** Poll until the owner approves, the code expires, or `until` passes. */
export async function waitForApproval(
  config: Config,
  pending: PendingLogin,
  deps: LoginDeps & { until?: number } = {},
): Promise<LoginResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  const deadline = Math.min(pending.expiresAt, deps.until ?? pending.expiresAt);
  const expired = { status: 'expired' as const, message: 'The login request expired. Run the command again.' };

  while (now() < deadline) {
    await sleep(pending.intervalMs);

    const polled = await fetchImpl(`${baseFrom(config.endpoint)}/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ device_code: pending.deviceCode }),
    });

    if (polled.status === 428) continue; // still waiting on the human
    if (!polled.ok) {
      if (config.siteUuid !== null) clearPendingLogin(config.siteUuid);
      return expired;
    }

    const { api_key: apiKey } = (await polled.json()) as { api_key?: string };
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      return { status: 'failed', message: 'Patchstack approved the request but returned no credential.' };
    }

    // Approving rotates the site's OAuth secret, which Pulse ingest and
    // block-log reporting both authenticate with.
    await persistApiKey(process.cwd(), apiKey);
    if (config.siteUuid !== null) clearPendingLogin(config.siteUuid);

    return { status: 'approved', userCode: pending.userCode, verificationUri: pending.verificationUri };
  }

  return expired;
}

/**
 * Start a flow and block until it resolves. For a terminal, where someone is
 * watching the output as it streams.
 */
export async function login(
  config: Config,
  onPrompt: (userCode: string, verificationUri: string) => void,
  deps: LoginDeps = {},
): Promise<LoginResult> {
  const started = await startLogin(config, deps);

  if (started.status !== 'started' || started.pending === undefined) {
    return { status: started.status === 'started' ? 'failed' : started.status, message: started.message };
  }

  onPrompt(started.pending.userCode, started.pending.verificationUri);

  return waitForApproval(config, started.pending, deps);
}

/** Exported for tests that need a scratch temp dir. */
export function makeTempDir(prefix = 'patchstack-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
