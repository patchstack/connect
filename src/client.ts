import { PatchstackError, type Config, type StoreManifestResponse } from './types.js';
import type { WirePayload } from './normalize.js';

export const DEFAULT_ENDPOINT = 'https://api.patchstack.com/monitor/pulse/manifest';
export const DEFAULT_TIMEOUT_MS = 30_000;

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Reject endpoint values that fetch would interpret unexpectedly. */
export function validateEndpoint(value: string): URL {
  if (value.length === 0 || value !== value.trim()) {
    throw new PatchstackError(
      'Patchstack endpoint must be a non-empty URL without surrounding whitespace.',
      'CONFIG_INVALID',
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new PatchstackError(
      `Patchstack endpoint "${value}" is not a valid URL.`,
      'CONFIG_INVALID',
      cause,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PatchstackError(
      `Patchstack endpoint must use http or https; got "${url.protocol}".`,
      'CONFIG_INVALID',
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new PatchstackError(
      'Patchstack endpoint must not contain embedded credentials.',
      'CONFIG_INVALID',
    );
  }
  if (url.hash !== '') {
    throw new PatchstackError(
      'Patchstack endpoint must not contain a URL fragment.',
      'CONFIG_INVALID',
    );
  }
  return url;
}

export function buildEndpointUrl(base: string, siteUuid?: string | null): string {
  const url = validateEndpoint(base);
  if (siteUuid === undefined || siteUuid === null || siteUuid.length === 0) {
    return base.replace(/\/$/, '');
  }

  // Mutate the parsed pathname rather than concatenating strings. This keeps a
  // staging endpoint's query parameters after the UUID instead of accidentally
  // appending the UUID inside the query string.
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(siteUuid)}`;
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
  const origin = validateEndpoint(endpoint).origin;
  return `${origin}/monitor/claim?site=${encodeURIComponent(siteUuid)}`;
}

export async function postManifest(
  config: Config,
  payload: WirePayload,
): Promise<StoreManifestResponse> {
  if (config.siteUuid !== null && !isUuid(config.siteUuid)) {
    throw new PatchstackError(
      `Site UUID "${config.siteUuid}" does not look like a valid UUID. Refusing to send a request that could provision or target the wrong site.`,
      'CONFIG_INVALID',
    );
  }

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
  let parsedBody: unknown = null;
  try {
    parsedBody = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsedBody = null;
  }
  const body = isRecord(parsedBody) ? parsedBody : null;

  if (response.status === 404) {
    throw new PatchstackError(
      stringField(body, 'error') ?? 'Site not found. Check that your site UUID is correct and that the app is registered as a Pulse app in your Patchstack dashboard.',
      'SITE_NOT_FOUND',
    );
  }

  if (response.status === 422) {
    throw new PatchstackError(
      stringField(body, 'message') ?? 'Patchstack rejected the manifest payload (validation failed).',
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
    throw new PatchstackError(
      text.length === 0
        ? 'Patchstack returned an empty response.'
        : 'Patchstack returned an invalid JSON response object.',
      'SERVER_ERROR',
    );
  }

  if (typeof body.stored !== 'boolean') {
    throw new PatchstackError(
      'Patchstack returned an invalid response: "stored" must be a boolean.',
      'SERVER_ERROR',
    );
  }

  if (body.uuid !== undefined && (typeof body.uuid !== 'string' || !isUuid(body.uuid))) {
    throw new PatchstackError(
      'Patchstack returned an invalid response: "uuid" must be a valid UUID.',
      'SERVER_ERROR',
    );
  }

  if (config.siteUuid === null && body.uuid === undefined) {
    throw new PatchstackError(
      'Patchstack did not return the UUID required to finish provisioning this site.',
      'SERVER_ERROR',
    );
  }

  if (
    config.siteUuid !== null &&
    body.uuid !== undefined &&
    body.uuid.toLowerCase() !== config.siteUuid.toLowerCase()
  ) {
    throw new PatchstackError(
      `Patchstack returned site UUID ${body.uuid}, but this request targeted ${config.siteUuid}. No local files were changed.`,
      'SERVER_ERROR',
    );
  }

  return body as unknown as StoreManifestResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(body: Record<string, unknown> | null, field: string): string | undefined {
  const value = body?.[field];
  return typeof value === 'string' ? value : undefined;
}

function isTimeoutError(cause: unknown): boolean {
  if (cause instanceof Error) {
    return cause.name === 'TimeoutError' || cause.name === 'AbortError';
  }
  return false;
}
