export type Ecosystem = 'npm' | 'composer';

/**
 * Which environment a manifest was captured in. The connector reports from real
 * builds (prebuild scan / build hooks), so it defaults to 'production'. Override
 * with PATCHSTACK_ENVIRONMENT=sandbox (or "environment" in .patchstackrc.json)
 * for test manifests.
 */
export type Environment = 'production' | 'sandbox';

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
  endpoint: string;
  timeoutMs: number;
  /** Environment to report the manifest under. Defaults to 'production'. */
  environment: Environment;
  /**
   * Whether the connector manages the disclosure-widget tag (source shell on
   * `scan`, built HTML on `mark-build`). Defaults to true; persist
   * `"widget": false` in .patchstackrc.json for dependency-scanning only.
   */
  widget: boolean;
}

export interface StoreManifestResponse {
  /** The UUID of the site the manifest was stored against. Always returned. */
  uuid?: string;
  stored: boolean;
  manifest_id?: number;
  checksum?: string;
  reason?: string;
  message?: string;
  error?: string;
}

export class PatchstackError extends Error {
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
      | 'VALIDATION_ERROR'
      | 'SERVER_ERROR',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PatchstackError';
  }
}
