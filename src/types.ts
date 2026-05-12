export type Ecosystem = 'npm' | 'composer';

export interface PackageEntry {
  name: string;
  version: string;
  path?: string;
  direct?: boolean;
}

export interface Manifest {
  ecosystem: Ecosystem;
  packages: PackageEntry[];
}

export interface Config {
  siteUuid: string;
  endpoint: string;
  timeoutMs: number;
}

export interface StoreManifestResponse {
  stored: boolean;
  manifest_id?: number;
  checksum?: string;
  reason?: string;
  message?: string;
  error?: string;
}

export interface RedeemIntegrationTokenResponse {
  uuid: string;
  site_id: number;
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
      | 'SERVER_ERROR'
      | 'TOKEN_INVALID'
      | 'TOKEN_USED_OR_EXPIRED'
      | 'BOOTSTRAP_FAILED',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PatchstackError';
  }
}
