import { PatchstackError, type Config, type StoreManifestResponse } from './types.js';
import type { WirePayload } from './normalize.js';

export const DEFAULT_ENDPOINT = 'http://api.patchstack.com/monitor/pulse/manifest';
export const DEFAULT_TIMEOUT_MS = 30_000;

export function buildEndpointUrl(base: string, siteUuid?: string | null): string {
  const trimmed = base.replace(/\/$/, '');
  return siteUuid !== undefined && siteUuid !== null && siteUuid.length > 0
    ? `${trimmed}/${encodeURIComponent(siteUuid)}`
    : trimmed;
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
      body: JSON.stringify(payload),
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
