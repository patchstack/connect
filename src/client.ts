import { PatchstackError, type Config, type StoreManifestResponse } from './types.js';
import type { WirePayload } from './normalize.js';

export const DEFAULT_ENDPOINT = 'https://app.patchstack.com/monitor/pulse/manifest';

export function buildEndpointUrl(base: string, siteUuid: string): string {
  const trimmed = base.replace(/\/$/, '');
  return `${trimmed}/${encodeURIComponent(siteUuid)}`;
}

export async function postManifest(
  config: Config,
  payload: WirePayload,
): Promise<StoreManifestResponse> {
  const url = buildEndpointUrl(config.endpoint, config.siteUuid);

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
    });
  } catch (cause) {
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
