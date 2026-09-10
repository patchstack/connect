import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { persistApiKey } from './config.js';
import {
  clearPending,
  pollDeviceToken,
  pollUntilApproved,
  readPending,
  requestDeviceCode,
  savePending,
  type DeviceFlowDeps,
  type PendingDeviceFlow,
} from './device-flow.js';
import type { Config } from './types.js';

/**
 * Credential recovery: ask the site's existing OWNER to approve reissuing it.
 *
 * The device authorization transport lives in `device-flow.ts`, shared with `claim`. What is specific
 * here is the meaning of an approval — a rotated credential, which this module persists — and the
 * refusal when the site has no owner to ask.
 */

export type LoginDeps = DeviceFlowDeps;
export type PendingLogin = PendingDeviceFlow;

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

const UNCLAIMED =
  'This site has not been claimed yet, so there is no owner to approve the request. Claim it with `patchstack-connect claim`, or delete .patchstackrc.json to provision a new site.';

export function savePendingLogin(siteUuid: string, pending: PendingLogin): void {
  savePending(siteUuid, 'login', pending);
}

export function readPendingLogin(siteUuid: string): PendingLogin | null {
  return readPending(siteUuid, 'login');
}

export function clearPendingLogin(siteUuid: string): void {
  clearPending(siteUuid, 'login');
}

/** Ask for a code. Returns as soon as the link is available. */
export async function startLogin(config: Config, deps: LoginDeps = {}): Promise<StartResult> {
  const started = await requestDeviceCode(config, 'login', UNCLAIMED, deps);

  // 'conflict' for a login is the site having nobody to approve the request.
  if (started.status === 'conflict') return { status: 'unclaimed', message: started.message };

  return started as StartResult;
}

/**
 * Redeem a pending request if the owner has already approved it, without waiting. Lets a second
 * `login` finish a flow the first one started, so an assistant that comes back after the user
 * approves does the right thing whether or not it remembers the `--wait` flag.
 */
export async function redeemIfApproved(
  config: Config,
  pending: PendingLogin,
  deps: LoginDeps = {},
): Promise<'approved' | 'pending' | 'expired'> {
  const polled = await pollDeviceToken(config, 'login', pending, deps);
  if (polled.state !== 'approved') return polled.state;

  const apiKey = polled.body?.api_key;
  if (typeof apiKey !== 'string' || apiKey.length === 0) return 'expired';

  await persistApiKey(process.cwd(), apiKey);

  return 'approved';
}

/** Poll until the owner approves, the code expires, or `until` passes. */
export async function waitForApproval(
  config: Config,
  pending: PendingLogin,
  deps: LoginDeps & { until?: number } = {},
): Promise<LoginResult> {
  const polled = await pollUntilApproved(config, 'login', pending, deps);

  if (polled.state === 'expired') {
    return { status: 'expired', message: 'The login request expired. Run the command again.' };
  }

  const apiKey = polled.body?.api_key;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return { status: 'failed', message: 'Patchstack approved the request but returned no credential.' };
  }

  // Approving rotates the site's OAuth secret, which Pulse ingest and block-log reporting both
  // authenticate with.
  await persistApiKey(process.cwd(), apiKey);

  return { status: 'approved', userCode: pending.userCode, verificationUri: pending.verificationUri };
}

/**
 * Start a flow and block until it resolves. For a terminal, where someone is watching the output as
 * it streams.
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
