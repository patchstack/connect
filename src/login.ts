import { persistPulseAuth } from './config.js';
import type { Config } from './types.js';

/**
 * Device authorization flow (RFC 8628) for recovering a lost credential.
 *
 * The device code stays in this process; the short user code is what the human
 * carries to the browser. Approving rotates the site's credential, so the old
 * one — wherever it leaked to — stops working.
 */

export interface LoginDeps {
  fetchImpl?: typeof fetch;
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function baseFrom(manifestEndpoint: string): string {
  const url = new URL(manifestEndpoint);
  const path = url.pathname.replace(/\/$/, '');
  url.pathname = path.endsWith('/manifest') ? path.slice(0, -'/manifest'.length) : '/monitor/pulse';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export interface LoginResult {
  status: 'approved' | 'denied' | 'expired' | 'unclaimed' | 'not-found' | 'failed';
  message?: string;
  userCode?: string;
  verificationUri?: string;
}

/**
 * Start a flow and poll until the owner approves or the code expires.
 * `onPrompt` is called once with the code to show the user.
 */
export async function login(
  config: Config,
  onPrompt: (userCode: string, verificationUri: string) => void,
  deps: LoginDeps = {},
): Promise<LoginResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
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
      message: 'This site has not been claimed yet, so there is no owner to approve the request. Claim it in the dashboard, or delete .patchstackrc.json to provision a new site.',
    };
  }
  if (started.status === 404) {
    return { status: 'not-found', message: 'Patchstack does not recognise this site UUID.' };
  }
  if (!started.ok) {
    return { status: 'failed', message: `Could not start the login (HTTP ${started.status}).` };
  }

  const { device_code: deviceCode, user_code: userCode, expires_in: expiresIn, interval } =
    (await started.json()) as {
      device_code: string;
      user_code: string;
      expires_in: number;
      interval: number;
    };

  const verificationUri = `${new URL(base).origin}/activate`;
  onPrompt(userCode, verificationUri);

  const deadline = now() + expiresIn * 1000;
  const intervalMs = Math.max(1, interval) * 1000;

  while (now() < deadline) {
    await sleep(intervalMs);

    const polled = await fetchImpl(`${base}/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    });

    if (polled.status === 428) continue; // still waiting on the human
    if (!polled.ok) return { status: 'expired', message: 'The login request expired. Run the command again.' };

    const { api_key: apiKey } = (await polled.json()) as { api_key?: string };
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      return { status: 'failed', message: 'Patchstack approved the request but returned no credential.' };
    }

    await persistPulseAuth(process.cwd(), apiKey);

    return { status: 'approved', userCode, verificationUri };
  }

  return { status: 'expired', message: 'The login request expired. Run the command again.' };
}
