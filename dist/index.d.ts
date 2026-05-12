type Ecosystem = 'npm' | 'composer';
interface PackageEntry {
    name: string;
    version: string;
    path?: string;
    direct?: boolean;
}
interface Manifest {
    ecosystem: Ecosystem;
    packages: PackageEntry[];
}
interface Config {
    siteUuid: string;
    endpoint: string;
    timeoutMs: number;
}
interface StoreManifestResponse {
    stored: boolean;
    manifest_id?: number;
    checksum?: string;
    reason?: string;
    message?: string;
    error?: string;
}
interface RedeemIntegrationTokenResponse {
    uuid: string;
    site_id: number;
}
declare class PatchstackError extends Error {
    readonly code: 'CONFIG_MISSING' | 'CONFIG_INVALID' | 'LOCKFILE_NOT_FOUND' | 'LOCKFILE_UNSUPPORTED' | 'LOCKFILE_PARSE_ERROR' | 'NETWORK_ERROR' | 'NETWORK_TIMEOUT' | 'SITE_NOT_FOUND' | 'VALIDATION_ERROR' | 'SERVER_ERROR' | 'TOKEN_INVALID' | 'TOKEN_USED_OR_EXPIRED' | 'BOOTSTRAP_FAILED';
    readonly cause?: unknown | undefined;
    constructor(message: string, code: 'CONFIG_MISSING' | 'CONFIG_INVALID' | 'LOCKFILE_NOT_FOUND' | 'LOCKFILE_UNSUPPORTED' | 'LOCKFILE_PARSE_ERROR' | 'NETWORK_ERROR' | 'NETWORK_TIMEOUT' | 'SITE_NOT_FOUND' | 'VALIDATION_ERROR' | 'SERVER_ERROR' | 'TOKEN_INVALID' | 'TOKEN_USED_OR_EXPIRED' | 'BOOTSTRAP_FAILED', cause?: unknown | undefined);
}

interface DetectedLockfile {
    ecosystem: 'npm';
    filePath: string;
    filename: 'package-lock.json' | 'yarn.lock' | 'pnpm-lock.yaml';
}
declare function detectLockfile(cwd: string): Promise<DetectedLockfile>;
declare function scanLockfile(cwd: string): Promise<Manifest>;

interface WirePackage {
    name: string;
    version: string;
}
interface WirePayload {
    ecosystem: Manifest['ecosystem'];
    packages: WirePackage[];
}
interface NormalizeStats {
    uniqueNames: number;
    duplicateNames: string[];
    totalEntries: number;
}
interface NormalizeResult {
    payload: WirePayload;
    stats: NormalizeStats;
}
declare function buildWirePayload(manifest: Manifest): NormalizeResult;
declare function compareVersions(a: string, b: string): number;

declare const DEFAULT_API_BASE_URL = "https://app.patchstack.com/monitor";
declare const DEFAULT_ENDPOINT = "https://app.patchstack.com/monitor/pulse/manifest";
declare const DEFAULT_TIMEOUT_MS = 30000;
declare function buildEndpointUrl(base: string, siteUuid: string): string;
declare function buildRedeemUrl(apiBaseUrl: string): string;
declare function buildManifestEndpoint(apiBaseUrl: string): string;
interface RedeemIntegrationTokenOptions {
    apiBaseUrl?: string;
    url?: string;
    appType?: string;
    timeoutMs?: number;
}
declare function redeemIntegrationToken(token: string, options?: RedeemIntegrationTokenOptions): Promise<RedeemIntegrationTokenResponse>;
declare function postManifest(config: Config, payload: WirePayload): Promise<StoreManifestResponse>;

interface ConfigFile {
    siteUuid?: string;
    endpoint?: string;
    timeoutMs?: number;
}
interface ResolveConfigOptions {
    cwd: string;
    cliSiteUuid?: string;
    cliEndpoint?: string;
}
declare function resolveConfig(options: ResolveConfigOptions): Promise<Config>;
declare function writeConfigFile(cwd: string, config: ConfigFile): Promise<string>;

interface ScanAndReportOptions {
    cwd?: string;
    config?: Config;
}
interface ScanAndReportResult {
    manifest: Manifest;
    response: StoreManifestResponse;
    duplicateNames: string[];
    uniqueNames: number;
    totalEntries: number;
}
declare function scanAndReport(options?: ScanAndReportOptions): Promise<ScanAndReportResult>;

export { type Config, DEFAULT_API_BASE_URL, DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS, type Ecosystem, type Manifest, type PackageEntry, PatchstackError, type RedeemIntegrationTokenOptions, type RedeemIntegrationTokenResponse, type ScanAndReportOptions, type ScanAndReportResult, type StoreManifestResponse, buildEndpointUrl, buildManifestEndpoint, buildRedeemUrl, buildWirePayload, compareVersions, detectLockfile, postManifest, redeemIntegrationToken, resolveConfig, scanAndReport, scanLockfile, writeConfigFile };
