import { PatchstackError, type Config, type StoreManifestResponse } from './types.js';
import type { WirePayload } from './normalize.js';
import { pulseFetch } from './pulse-token.js';

export const DEFAULT_ENDPOINT = 'https://api.patchstack.com/monitor/pulse/manifest';
export const DEFAULT_TIMEOUT_MS = 30_000;

export function buildEndpointUrl(base: string, siteUuid?: string | null): string {
  const trimmed = base.replace(/\/$/, '');
  return siteUuid !== undefined && siteUuid !== null && siteUuid.length > 0
    ? `${trimmed}/${encodeURIComponent(siteUuid)}`
    : trimmed;
}

/**
 * What a refusal means, in terms someone can act on.
 *
 * Every Pulse route that addresses an existing site requires a credential, so a rejection is now the
 * most likely failure a misconfigured project hits — and the three causes have three different fixes.
 * Reporting them as `Patchstack returned 401` names none of them, and this output is frequently read by
 * an AI agent that has no other way to find out what to do next.
 *
 * The distinction 401 cannot make on its own is whether we HELD a credential. Having none is a setup
 * step that was never run; having one rejected is a credential that has expired, been revoked, or whose
 * site no longer exists. A 403 is different again: the credential is valid and simply is not for this
 * site, which usually means a `.patchstackrc.json` carrying someone else's UUID.
 *
 * @returns the message, or null when the status is not an authentication failure
 */
export function authFailureMessage(status: number, config: Config): string | null {
  const hasCredential = typeof config.pulseAuth === 'string' && config.pulseAuth.length > 0;

  if (status === 401 && !hasCredential) {
    return 'Patchstack requires an API credential for this site and none is configured. Run `npx patchstack-connect login`, or set PATCHSTACK_API_KEY.';
  }
  if (status === 401) {
    return 'Patchstack rejected this API credential. It may have expired, been revoked, or the site may no longer exist. Run `npx patchstack-connect login` to issue a new one.';
  }
  if (status === 403) {
    return 'This API credential is not permitted to act on this site. Check that siteUuid in .patchstackrc.json matches the credential (a credential is issued for one site).';
  }

  return null;
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

/** Build the package-removed signal URL corresponding to a manifest endpoint override. */
export function buildPackageRemovedUrl(manifestEndpoint: string, siteUuid: string): string {
  const url = new URL(manifestEndpoint);
  const path = url.pathname.replace(/\/$/, '');
  url.pathname = path.endsWith('/manifest')
    ? `${path.slice(0, -'/manifest'.length)}/package-removed/${encodeURIComponent(siteUuid)}`
    : `/monitor/pulse/package-removed/${encodeURIComponent(siteUuid)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Build the input-map ingest URL corresponding to a manifest endpoint override. */
export function buildInputMapUrl(manifestEndpoint: string, siteUuid: string): string {
  const url = new URL(manifestEndpoint);
  const path = url.pathname.replace(/\/$/, '');
  url.pathname = path.endsWith('/manifest')
    ? `${path.slice(0, -'/manifest'.length)}/input-map/${encodeURIComponent(siteUuid)}`
    : `/monitor/pulse/input-map/${encodeURIComponent(siteUuid)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Outcome of uploading an attack-surface map. `unchanged` is a first-class result, not a failure: most
 * builds do not change the surface, and the server keeps one revision per distinct surface rather than
 * one per deploy. `skipped` covers the cases where there is nothing to send or nowhere to send it.
 */
export type InputMapUploadOutcome =
  | { result: 'stored'; revision: number }
  | { result: 'unchanged'; revision: number }
  | { result: 'skipped'; message: string }
  | { result: 'failed'; message: string };

/**
 * Upload an attack-surface map for this site.
 *
 * Fail-open by construction: every failure path returns a result rather than throwing, because this runs
 * during someone's build and a Patchstack outage must never break it. The caller decides what to print.
 */
export async function postInputMap(
  config: Config,
  map: { version: number; endpoints: unknown[] },
): Promise<InputMapUploadOutcome> {
  if (config.siteUuid === null) {
    return { result: 'skipped', message: 'No site UUID configured — run `patchstack-connect scan` first.' };
  }

  const url = buildInputMapUrl(config.endpoint, config.siteUuid);
  try {
    const response = await pulseFetch(config, url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': '@patchstack/connect',
      },
      body: JSON.stringify(map),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (response.status === 404) {
      return { result: 'failed', message: 'Site not found — the configured site UUID is unknown to Patchstack.' };
    }
    if (response.status === 422) {
      // The server implements a different map schema than this client emits. Say so plainly: it means
      // one side is out of date, and guessing at compatibility is how a consumer misreads a document.
      return { result: 'failed', message: `Patchstack does not accept this map schema (version ${map.version}). Update @patchstack/connect.` };
    }
    const refused = authFailureMessage(response.status, config);
    if (refused !== null) {
      return { result: 'failed', message: refused };
    }
    if (!response.ok) {
      return { result: 'failed', message: `Patchstack returned ${response.status}.` };
    }
    const body = (await response.json()) as { result?: string; revision?: number };
    // The revision is part of the contract, not decoration: "stored, revision 0" is not a state the server
    // can be in, so accepting it would report a successful upload that cannot be pointed at afterwards.
    const revision = Number(body.revision);
    if ((body.result === 'stored' || body.result === 'unchanged') && Number.isInteger(revision) && revision > 0) {
      return { result: body.result, revision };
    }
    return { result: 'failed', message: 'Patchstack returned an unexpected response.' };
  } catch {
    return { result: 'failed', message: `Could not reach Patchstack at ${url}.` };
  }
}

/**
 * Outcome of the package-removed signal. 'deleted' — the site was unclaimed
 * and its record was removed; 'flagged' — the site is claimed, so it was only
 * marked for its owner to confirm removal in the dashboard; 'gone' — the
 * record no longer existed; 'failed' — Patchstack could not be reached or
 * returned an unexpected response.
 */
export interface PackageRemovedOutcome {
  result: 'deleted' | 'flagged' | 'gone' | 'failed';
  message: string | null;
}

/**
 * Tell Patchstack the @patchstack/connect package is being uninstalled from
 * this project. The site UUID is the only credential, so the server deletes
 * only unclaimed (anonymous) sites; claimed sites are merely flagged for
 * their owner. Never throws — an unreachable server must not block the local
 * uninstall.
 */
export async function postPackageRemoved(config: Config): Promise<PackageRemovedOutcome> {
  if (config.siteUuid === null) {
    return { result: 'failed', message: 'No site UUID configured.' };
  }

  const url = buildPackageRemovedUrl(config.endpoint, config.siteUuid);
  try {
    const response = await pulseFetch(config, url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': '@patchstack/connect',
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (response.status === 404) {
      return { result: 'gone', message: null };
    }
    // A site that has been deleted answers 401 here, not 404: this route resolves the site FROM the
    // credential, so once the site record is gone the credential resolves to nothing. Reporting that as
    // an auth failure would tell someone to re-run `login` over a site that no longer exists, so the
    // question is put to the endpoint that can still answer it — widget settings, which needs no
    // credential and 404s for a removed site.
    if (response.status === 401 && (await fetchSiteStatus(config)) === 'removed') {
      return { result: 'gone', message: null };
    }
    const refused = authFailureMessage(response.status, config);
    if (refused !== null) {
      return { result: 'failed', message: refused };
    }
    if (!response.ok) {
      return { result: 'failed', message: `Patchstack returned ${response.status}.` };
    }
    const body = (await response.json()) as { status?: string; message?: string };
    if (body.status === 'deleted' || body.status === 'flagged') {
      return { result: body.status, message: body.message ?? null };
    }
    return { result: 'failed', message: 'Patchstack returned an unexpected response.' };
  } catch {
    return { result: 'failed', message: `Could not reach Patchstack at ${url}.` };
  }
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
    // Unauthenticated on the bootstrap POST: there is no credential until this
    // request issues one.
    response = await pulseFetch(config, url, {
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

  const refused = authFailureMessage(response.status, config);
  if (refused !== null) {
    throw new PatchstackError(refused, 'UNAUTHORIZED');
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
