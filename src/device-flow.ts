import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pulseFetch } from './pulse-token.js';
import type { Config } from './types.js';

/**
 * The device authorization flow (RFC 8628) shared by `login` and `claim`.
 *
 * Both commands need the same thing from Patchstack: a code the user approves in a browser, polled
 * from a terminal that cannot open one. They differ only in what the approval MEANS — `login` asks an
 * existing owner to reissue a credential, `claim` asks whoever authenticates to become the owner — so
 * the transport lives here and each command interprets its own approval.
 *
 * The split into "ask for a code" and "poll" is load-bearing, not tidiness. A person at a terminal
 * wants one command that prints a code and blocks. An assistant runs a command, waits for it to exit,
 * and only then reads the output — so a command that blocks for ten minutes shows it nothing until the
 * code has already expired, and looks like a hang.
 */

/** Which approval is being asked for. Sent to the server and used to key the pending request. */
export type DeviceIntent = 'login' | 'claim';

export interface DeviceFlowDeps {
  fetchImpl?: typeof fetch;
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PendingDeviceFlow {
  /** Redeems the approval. Never printed — it is a secret. */
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
}

/**
 * Outcome of asking for a code. `conflict` is the server refusing on the site's claim state — which
 * state that is depends on the intent, and is opposite for the two: `login` needs an owner to approve
 * and has none, `claim` needs the site to be unowned and it already has one. The caller supplies the
 * wording because only it knows which way round the refusal reads.
 */
export interface StartOutcome {
  status: 'started' | 'conflict' | 'not-found' | 'failed';
  pending?: PendingDeviceFlow;
  message?: string;
}

/** One poll of the token endpoint. `body` is the approval payload, which each intent reads differently. */
export interface PollOutcome {
  state: 'approved' | 'pending' | 'expired';
  body?: Record<string, unknown>;
}

/**
 * The Pulse base for an endpoint override, so a run pointed at staging or a local API keeps its whole
 * flow — code, poll and the approval link the user opens — on that same host.
 */
export function baseFrom(manifestEndpoint: string): string {
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
 * The temp directory rather than the project: the device code is a secret with a ten-minute life, and
 * nothing that short-lived belongs in a repo where it could be committed. Keyed by site AND intent so
 * a claim and a login for the same site do not overwrite each other.
 */
function pendingPath(siteUuid: string, intent: DeviceIntent): string {
  const key = createHash('sha256').update(siteUuid).digest('hex').slice(0, 16);
  return path.join(tmpdir(), `patchstack-${intent}-${key}.json`);
}

export function savePending(siteUuid: string, intent: DeviceIntent, pending: PendingDeviceFlow): void {
  const target = pendingPath(siteUuid, intent);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(pending), 'utf8');
    closeSync(descriptor);
    descriptor = null;
    try {
      renameSync(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || (code !== 'EEXIST' && code !== 'EPERM')) throw error;
      try {
        rmSync(target);
      } catch (removeError) {
        if ((removeError as NodeJS.ErrnoException).code !== 'ENOENT') throw removeError;
      }
      renameSync(temporary, target);
    }
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      rmSync(temporary);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

export function readPending(siteUuid: string, intent: DeviceIntent): PendingDeviceFlow | null {
  let descriptor: number | null = null;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(pendingPath(siteUuid, intent), constants.O_RDONLY | noFollow);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return null;
    if (typeof process.getuid === 'function' && typeof stat.uid === 'number' && stat.uid !== process.getuid()) {
      return null;
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return null;
    return JSON.parse(readFileSync(descriptor, 'utf8')) as PendingDeviceFlow;
  } catch {
    return null; // absent, unreadable, or corrupt — all mean "nothing pending"
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        /* already closed */
      }
    }
  }
}

export function clearPending(siteUuid: string, intent: DeviceIntent): void {
  try {
    rmSync(pendingPath(siteUuid, intent));
  } catch {
    /* already gone */
  }
}

/**
 * Ask for a code. Returns as soon as the link is available.
 *
 * The request carries the site's bearer token whenever the project holds a credential, and none when
 * it does not — `pulseFetch` omits the header rather than failing. Starting a flow is not what the
 * guarantee rests on either way: the approval step is authenticated and is where the server decides
 * who may act on the site. Sending the token regardless lets the server treat it as proof that the
 * caller is the machine that provisioned the site, without the CLI depending on it having done so.
 */
export async function requestDeviceCode(
  config: Config,
  intent: DeviceIntent,
  conflictMessage: string,
  deps: DeviceFlowDeps = {},
): Promise<StartOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());

  if (config.siteUuid === null) {
    return {
      status: 'failed',
      message: 'No site UUID configured — run `patchstack-connect scan` first.',
    };
  }

  const base = baseFrom(config.endpoint);

  const started = await pulseFetch(
    config,
    `${base}/device/code`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ site_uuid: config.siteUuid, intent }),
    },
    fetchImpl,
  );

  if (started.status === 409) return { status: 'conflict', message: conflictMessage };
  if (started.status === 404) {
    return { status: 'not-found', message: 'Patchstack does not recognise this site UUID.' };
  }
  if (!started.ok) {
    return { status: 'failed', message: `Could not start the request (HTTP ${started.status}).` };
  }

  const body = (await started.json()) as {
    device_code: string;
    user_code: string;
    expires_in: number;
    interval: number;
  };

  const pending: PendingDeviceFlow = {
    deviceCode: body.device_code,
    userCode: body.user_code,
    // Points at the API, which redirects to the dashboard SPA — the CLI only knows the API origin,
    // and the approval page lives on the app.
    verificationUri: `${base}/device?code=${encodeURIComponent(body.user_code)}`,
    expiresAt: now() + body.expires_in * 1000,
    intervalMs: Math.max(1, body.interval) * 1000,
  };

  savePending(config.siteUuid, intent, pending);

  return { status: 'started', pending };
}

/**
 * Poll once, without waiting. Lets a second invocation finish a flow the first one started, so an
 * assistant that comes back after the user approves does the right thing whether or not it remembered
 * to block.
 *
 * The device code authenticates this request by itself, so it goes out unauthenticated: a bearer token
 * here would be a second answer to a question already answered, and one the caller may not have.
 */
export async function pollDeviceToken(
  config: Config,
  intent: DeviceIntent,
  pending: PendingDeviceFlow,
  deps: DeviceFlowDeps = {},
): Promise<PollOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const polled = await fetchImpl(`${baseFrom(config.endpoint)}/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ device_code: pending.deviceCode }),
  });

  if (polled.status === 428) return { state: 'pending' };

  if (!polled.ok) {
    if (config.siteUuid !== null) clearPending(config.siteUuid, intent);
    return { state: 'expired' };
  }

  const body = (await polled.json()) as Record<string, unknown>;
  if (config.siteUuid !== null) clearPending(config.siteUuid, intent);

  return { state: 'approved', body };
}

/** Poll until the user approves, the code expires, or `until` passes. */
export async function pollUntilApproved(
  config: Config,
  intent: DeviceIntent,
  pending: PendingDeviceFlow,
  deps: DeviceFlowDeps & { until?: number } = {},
): Promise<PollOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  const deadline = Math.min(pending.expiresAt, deps.until ?? pending.expiresAt);

  while (now() < deadline) {
    await sleep(pending.intervalMs);

    const outcome = await pollDeviceToken(config, intent, pending, deps);
    if (outcome.state !== 'pending') return outcome;
  }

  return { state: 'expired' };
}
