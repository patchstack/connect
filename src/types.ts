export type Ecosystem = 'npm' | 'composer';

/**
 * Where a manifest was built. `production` only when the hosting platform's own discriminator says this
 * build is the production one; `sandbox` for a preview it names as such, or a hosted builder's workspace;
 * `local` for everything else, a developer's machine included — inventory, never evidence of a live site.
 * Inferred when nothing sets it (see `environment.ts`); `PATCHSTACK_ENVIRONMENT` or `"environment"` in
 * .patchstackrc.json overrides.
 */
export type Environment = 'production' | 'sandbox' | 'local';

export interface PackageEntry {
  name: string;
  version: string;
  path?: string;
  direct?: boolean;
}

export interface Manifest {
  ecosystem: Ecosystem;
  packages: PackageEntry[];
  /**
   * Human-readable scan diagnostics — set when the preferred lockfile looked
   * stale (missing dependencies declared in package.json) and another source
   * was used, or when no fully-consistent source existed. Never fatal.
   */
  warnings?: string[];
}

export interface Config {
  /**
   * The site UUID. `null` means we don't have one yet — `postManifest` will then
   * post to the bare endpoint, the server will provision a fresh site, and the
   * UUID it returns should be persisted via `persistSiteUuid()`.
   */
  siteUuid: string | null;
  /**
   * WP-format site API key (`{oauth.secret}-{oauth.id}`) for authenticated
   * block-log reporting via connector `/api/logs/log`. Issued once as `api_key`
   * on first provision. Prefer `PATCHSTACK_API_KEY` in production deploys.
   */
  apiKey: string | null;
  /**
   * Credential for the authenticated Pulse endpoints (ADR-0018). Exchanged for
   * a short-lived bearer token at `monitor/pulse/token`; never sent directly.
   * Falls back to `apiKey` when unset. Prefer `PATCHSTACK_PULSE_AUTH`.
   */
  pulseAuth: string | null;
  /**
   * Where this app is published, reported alongside the manifest so a site provisioned without an
   * address can learn one. `null` when nothing reliable is known — a laptop build, or a platform that
   * publishes no production URL.
   *
   * Optional, and absent unless the config was resolved with `detectSiteIdentity`. Only the manifest
   * push reads it, and it is omitted from that push when it is not a string — so a caller holding a
   * `Config` it built itself keeps working without knowing this field exists.
   */
  siteUrl?: string | null;
  /**
   * What this app is called, reported alongside the manifest so a site provisioned nameless can learn a
   * name. `null` when the project states none — a name Patchstack would only be guessing at is not
   * reported. Optional on the same terms as `siteUrl`.
   */
  siteName?: string | null;
  endpoint: string;
  /**
   * Whether the endpoint came from an operator-controlled source. `false` means a committed project
   * file selected a custom endpoint, so credentials are withheld until the operator overrides it via
   * the command line or environment. Optional for callers that construct Config directly.
   */
  endpointTrusted?: boolean;
  timeoutMs: number;
  /** Environment to report the manifest under. Inferred from the build environment when not stated. */
  environment: Environment;
  /**
   * What decided `environment` when nothing set it: the hosting platform's own production or preview
   * discriminator. Empty when it was stated, and empty for `local`, which is decided by the absence of
   * any such evidence.
   */
  environmentEvidence?: string[];
  /**
   * Whether the connector manages the disclosure-widget tag (source shell on
   * `scan`, built HTML on `mark-build`). Defaults to true; persist
   * `"widget": false` in .patchstackrc.json for dependency-scanning only.
   */
  widget: boolean;
  /**
   * The claim token the Patchstack dashboard puts in its install prompt, so the site the first scan
   * provisions is born in that account instead of waiting for a dashboard link. Read from
   * `--claim-token` or `PATCHSTACK_CLAIM_TOKEN` and never written to any file: it names an account,
   * not this project, and it stops working within a day. Optional on the same terms as `siteUrl`.
   */
  claimToken?: string | null;
}

/**
 * What Patchstack did with a claim token that rode along with a manifest push.
 *
 * `claimed` — this push gave the site its owner; `owned-by-you` — it already was (a re-run of the
 * prompt); `owned-by-other` — the site belongs to a different account and was left alone;
 * `rejected` — the token had expired or was not one Patchstack issued, and the site stays as it was.
 */
export interface ManifestClaimOutcome {
  state: 'claimed' | 'owned-by-you' | 'owned-by-other' | 'rejected';
  site_id?: number | null;
  /** Where the connected site lives in the dashboard; present for `claimed` and `owned-by-you`. */
  dashboard_url?: string | null;
  reason?: 'expired' | 'invalid' | null;
}

export interface StoreManifestResponse {
  /** The UUID of the site the manifest was stored against. Always returned. */
  uuid?: string;
  /**
   * WP-format API key for connector log ingest. Present only when oauth
   * credentials are created in this request (first provision / backfill).
   */
  api_key?: string;
  stored: boolean;
  manifest_id?: number;
  checksum?: string;
  reason?: string;
  message?: string;
  error?: string;
  /** Present only when the push carried a claim token. */
  claim?: ManifestClaimOutcome;
}

export class PatchstackError extends Error {
  /**
   * For a `VALIDATION_ERROR`, the request fields the server refused, as it named them. Read from the
   * structured `errors` object a validation response carries, so a caller deciding what to do about a
   * refusal keys on the field rather than on the wording of a sentence.
   */
  public fields: readonly string[] = [];

  constructor(
    message: string,
    public readonly code:
      | 'CONFIG_MISSING'
      | 'CONFIG_INVALID'
      | 'LOCKFILE_NOT_FOUND'
      | 'LOCKFILE_UNSUPPORTED'
      | 'LOCKFILE_PARSE_ERROR'
      | 'NETWORK_ERROR'
      | 'NETWORK_TIMEOUT'
      | 'SITE_NOT_FOUND'
      | 'UNAUTHORIZED'
      | 'VALIDATION_ERROR'
      | 'SERVER_ERROR',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PatchstackError';
  }
}
