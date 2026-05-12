import {
  PatchstackError,
  type Config,
  type RedeemIntegrationTokenResponse,
  type StoreManifestResponse,
} from './types.js';
import type { WirePayload } from './normalize.js';

export const DEFAULT_API_BASE_URL = 'https://app.patchstack.com/monitor';
export const DEFAULT_ENDPOINT = `${DEFAULT_API_BASE_URL}/pulse/manifest`;
export const DEFAULT_TIMEOUT_MS = 30_000;

export function buildEndpointUrl(base: string, siteUuid: string): string {
  const trimmed = base.replace(/\/$/, '');
  return `${trimmed}/${encodeURIComponent(siteUuid)}`;
}

export function buildRedeemUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.replace(/\/$/, '');
  return `${trimmed}/pulse/integration/redeem`;
}

export function buildManifestEndpoint(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.replace(/\/$/, '');
  return `${trimmed}/pulse/manifest`;
}

export interface RedeemIntegrationTokenOptions {
  apiBaseUrl?: string;
  url?: string;
  appType?: string;
  timeoutMs?: number;
}

export async function redeemIntegrationToken(
  token: string,
  options: RedeemIntegrationTokenOptions = {},
): Promise<RedeemIntegrationTokenResponse> {
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = buildRedeemUrl(apiBaseUrl);

  const body: Record<string, string> = { token };
  if (options.url !== undefined && options.url !== '') body.url = options.url;
  if (options.appType !== undefined && options.appType !== '') body.app_type = options.appType;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': '@patchstack/connect',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    if (isTimeoutError(cause)) {
      throw new PatchstackError(
        `Patchstack request to ${url} timed out after ${timeoutMs}ms.`,
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
  let parsed: (RedeemIntegrationTokenResponse & { error?: string }) | null = null;
  try {
    parsed = text.length > 0
      ? (JSON.parse(text) as RedeemIntegrationTokenResponse & { error?: string })
      : null;
  } catch {
    parsed = null;
  }

  if (response.status === 404) {
    throw new PatchstackError(
      parsed?.error ?? 'Integration token not recognised. Generate a fresh one from the Patchstack dashboard.',
      'TOKEN_INVALID',
    );
  }

  if (response.status === 410) {
    throw new PatchstackError(
      parsed?.error ?? 'Integration token has already been used or expired. Generate a fresh one from the Patchstack dashboard.',
      'TOKEN_USED_OR_EXPIRED',
    );
  }

  if (response.status === 422) {
    throw new PatchstackError(
      parsed?.error ?? 'Patchstack rejected the token redemption request.',
      'VALIDATION_ERROR',
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw new PatchstackError(
      `Patchstack returned ${response.status}: ${text.slice(0, 200)}`,
      'SERVER_ERROR',
    );
  }

  if (parsed === null || typeof parsed.uuid !== 'string' || parsed.uuid.length === 0) {
    throw new PatchstackError('Patchstack did not return a site UUID for the integration token.', 'SERVER_ERROR');
  }

  return { uuid: parsed.uuid, site_id: parsed.site_id };
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
