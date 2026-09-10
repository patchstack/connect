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
 * Attach a provisioned site to a Patchstack account from the terminal.
 *
 * A scan provisions an ownerless site and prints a dashboard link. Opening a link is the whole flow
 * when the user is already in a browser looking at a preview; it is a dead end in a terminal, where
 * the link is a line of output that scrolls away and nothing afterwards can tell whether anybody
 * followed it. This runs the same claim as an approval the CLI can observe the result of.
 *
 * Uses the device authorization transport in `device-flow.ts`, the same one `login` uses. The two are
 * mirror images: `login` needs an owner and asks them to approve, `claim` needs the site to have no
 * owner and makes the approver one.
 *
 * Claiming does not rotate the site's credential. The project already holds a working one from
 * provisioning, and rotating it here would break CI, deploys and other checkouts for a step that has
 * nothing to do with them. A credential is persisted only when the server issues one — which it does
 * for a claim from a checkout that never had it.
 */

export type ClaimDeps = DeviceFlowDeps;
export type PendingClaim = PendingDeviceFlow;

export interface StartClaimResult {
  status: 'started' | 'already-claimed' | 'not-found' | 'failed';
  pending?: PendingClaim;
  message?: string;
}

export interface ClaimResult {
  status: 'claimed' | 'already-claimed' | 'expired' | 'not-found' | 'failed';
  message?: string;
  /** Who it was claimed by, when the server names them. Display only. */
  account?: string;
  /** Where to see the site now that it has an owner, when the server says. */
  dashboardUrl?: string;
  /** Whether an issued credential was written to the local secret file. */
  credentialSaved?: boolean;
}

const ALREADY_CLAIMED =
  'This site is already attached to a Patchstack account. Nothing to claim — sign in at the dashboard to see it, or use `patchstack-connect login` if you need its credential back.';

export function savePendingClaim(siteUuid: string, pending: PendingClaim): void {
  savePending(siteUuid, 'claim', pending);
}

export function readPendingClaim(siteUuid: string): PendingClaim | null {
  return readPending(siteUuid, 'claim');
}

export function clearPendingClaim(siteUuid: string): void {
  clearPending(siteUuid, 'claim');
}

/** Ask for a code. Returns as soon as the link is available. */
export async function startClaim(config: Config, deps: ClaimDeps = {}): Promise<StartClaimResult> {
  const started = await requestDeviceCode(config, 'claim', ALREADY_CLAIMED, deps);

  // 'conflict' for a claim is the site already having an owner.
  if (started.status === 'conflict') return { status: 'already-claimed', message: started.message };

  return started as StartClaimResult;
}

/**
 * Turn an approved poll into a result, persisting a credential if the server issued one.
 *
 * Split out because both the resume path and the blocking path need it, and a claim that silently
 * dropped an issued credential would leave the project unable to report.
 */
async function settle(body: Record<string, unknown> | undefined): Promise<ClaimResult> {
  const account = typeof body?.account === 'string' ? body.account : undefined;
  const dashboardUrl = typeof body?.dashboard_url === 'string' ? body.dashboard_url : undefined;

  const apiKey = body?.api_key;
  let credentialSaved = false;
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    await persistApiKey(process.cwd(), apiKey);
    credentialSaved = true;
  }

  return { status: 'claimed', account, dashboardUrl, credentialSaved };
}

/**
 * Redeem a pending claim if it has already been approved, without waiting. Lets a second `claim`
 * finish a flow the first one started, so an assistant that comes back after the user confirms
 * finishes rather than starting a second request against a link the user is still looking at.
 */
export async function redeemClaimIfApproved(
  config: Config,
  pending: PendingClaim,
  deps: ClaimDeps = {},
): Promise<ClaimResult | 'pending'> {
  const polled = await pollDeviceToken(config, 'claim', pending, deps);

  if (polled.state === 'pending') return 'pending';
  if (polled.state === 'expired') {
    return { status: 'expired', message: 'The claim request expired. Run the command again.' };
  }

  return settle(polled.body);
}

/** Poll until the user claims the site, the code expires, or `until` passes. */
export async function waitForClaim(
  config: Config,
  pending: PendingClaim,
  deps: ClaimDeps & { until?: number } = {},
): Promise<ClaimResult> {
  const polled = await pollUntilApproved(config, 'claim', pending, deps);

  if (polled.state === 'expired') {
    return { status: 'expired', message: 'The claim request expired. Run the command again.' };
  }

  return settle(polled.body);
}

/**
 * Start a flow and block until it resolves. For a terminal, where someone is watching the output as
 * it streams.
 */
export async function claim(
  config: Config,
  onPrompt: (userCode: string, verificationUri: string) => void,
  deps: ClaimDeps = {},
): Promise<ClaimResult> {
  const started = await startClaim(config, deps);

  if (started.status !== 'started' || started.pending === undefined) {
    return {
      status: started.status === 'started' ? 'failed' : started.status,
      message: started.message,
    };
  }

  onPrompt(started.pending.userCode, started.pending.verificationUri);

  return waitForClaim(config, started.pending, deps);
}
