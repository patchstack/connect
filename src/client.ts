import { PatchstackError, type Config, type StoreManifestResponse } from './types.js';
import type { WirePayload } from './normalize.js';

export const DEFAULT_ENDPOINT = 'https://api.patchstack.com/monitor/pulse/manifest';
export const DEFAULT_TIMEOUT_MS = 30_000;

export function buildEndpointUrl(base: string, siteUuid?: string | null): string {
  const trimmed = base.replace(/\/$/, '');
  return siteUuid !== undefined && siteUuid !== null && siteUuid.length > 0
    ? `${trimmed}/${encodeURIComponent(siteUuid)}`
    : trimmed;
}

/** Build the live Pulse rules URL corresponding to a manifest endpoint override. */
export function buildRulesUrl(manifestEndpoint: string, siteUuid: string): string {
  const url = new URL(manifestEndpoint);
  const path = url.pathname.replace(/\/$/, '');
  url.pathname = path.endsWith('/manifest')
    ? `${path.slice(0, -'/manifest'.length)}/rules/${encodeURIComponent(siteUuid)}`
    : `/monitor/pulse/rules/${encodeURIComponent(siteUuid)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Build the claim URL for a site. The claim page lives on the same origin as
 * the API endpoint, at `/monitor/claim?site=<uuid>`. Using the API endpoint's
 * origin (rather than a hard-coded https://api.patchstack.com) means staging,
 * ngrok tunnels and local dev environments all produce a claim URL on the same
 * host the connector is already talking to.
 */
export function buildClaimUrl(endpoint: string, siteUuid: string): string {
  const origin = new URL(endpoint).origin;
  return `${origin}/monitor/claim?site=${encodeURIComponent(siteUuid)}`;
}

/**
 * Build the public widget-settings URL for a site. Like the claim URL, it
 * lives on the API endpoint's origin, at `/monitor/widget/settings/<uuid>`.
 */
export function buildSettingsUrl(endpoint: string, siteUuid: string): string {
  const origin = new URL(endpoint).origin;
  return `${origin}/monitor/widget/settings/${encodeURIComponent(siteUuid)}`;
}

/**
 * Whether the site record still exists on Patchstack's side. Removing a site
 * (dashboard delete or the widget's uninstall flow) only deletes the remote
 * record — the local integration files stay in the project — so this is the
 * signal that distinguishes "removed from Patchstack" from "still active".
 */
export type SiteStatus = 'active' | 'removed' | 'unknown';

/**
 * Check the remote site status via the public widget-settings endpoint:
 * 200 means the site record exists, 404 means it was removed. Any other
 * response or a network failure is 'unknown' — never throws. The endpoint's
 * 200 responses are cacheable for an hour, so a cache-busting query param
 * keeps intermediaries from reporting a just-removed site as active.
 */
export async function fetchSiteStatus(config: Config): Promise<SiteStatus> {
  if (config.siteUuid === null) return 'unknown';

  const url = new URL(buildSettingsUrl(config.endpoint, config.siteUuid));
  url.searchParams.set('t', Date.now().toString());

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        'User-Agent': '@patchstack/connect',
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (response.status === 404) return 'removed';
    if (response.ok) return 'active';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function postManifest(
  config: Config,
  payload: WirePayload,
): Promise<StoreManifestResponse> {
  const url = buildEndpointUrl(config.endpoint, config.siteUuid);
  const timeoutMs = config.timeoutMs;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': '@patchstack/connect',
      },
      body: JSON.stringify({ ...payload, environment: config.environment }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    if (isTimeoutError(cause)) {
      throw new PatchstackError(
        `Patchstack request to ${url} timed out after ${timeoutMs}ms. Override with PATCHSTACK_TIMEOUT_MS.`,
        'NETWORK_TIMEOUT',
        cause,
      );
    }
    throw new PatchstackError(
      `Could not reach Patchstack at ${url}. Check your network connection.`,
      'NETWORK_ERROR',
      cause,
    );
  }

  const text = await response.text();
  let body: StoreManifestResponse | null = null;
  try {
    body = text.length > 0 ? (JSON.parse(text) as StoreManifestResponse) : null;
  } catch {
    body = null;
  }

  if (response.status === 404) {
    throw new PatchstackError(
      body?.error ?? 'Site not found. Check that your site UUID is correct and that the app is registered as a Pulse app in your Patchstack dashboard.',
      'SITE_NOT_FOUND',
    );
  }

  if (response.status === 422) {
    throw new PatchstackError(
      body?.message ?? 'Patchstack rejected the manifest payload (validation failed).',
      'VALIDATION_ERROR',
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw new PatchstackError(
      `Patchstack returned ${response.status}: ${text.slice(0, 200)}`,
      'SERVER_ERROR',
    );
  }

  if (body === null) {
    throw new PatchstackError('Patchstack returned an empty response.', 'SERVER_ERROR');
  }

  return body;
}

function isTimeoutError(cause: unknown): boolean {
  if (cause instanceof Error) {
    return cause.name === 'TimeoutError' || cause.name === 'AbortError';
  }
  return false;
}
