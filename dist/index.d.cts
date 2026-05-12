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
    /**
     * The site UUID. `null` means we don't have one yet — `postManifest` will then
     * post to the bare endpoint, the server will provision a fresh site, and the
     * UUID it returns should be persisted via `persistSiteUuid()`.
     */
    siteUuid: string | null;
    endpoint: string;
    timeoutMs: number;
}
interface StoreManifestResponse {
    /** The UUID of the site the manifest was stored against. Always returned. */
    uuid?: string;
    stored: boolean;
    manifest_id?: number;
    checksum?: string;
    reason?: string;
    message?: string;
    error?: string;
}
declare class PatchstackError extends Error {
    readonly code: 'CONFIG_MISSING' | 'CONFIG_INVALID' | 'LOCKFILE_NOT_FOUND' | 'LOCKFILE_UNSUPPORTED' | 'LOCKFILE_PARSE_ERROR' | 'NETWORK_ERROR' | 'NETWORK_TIMEOUT' | 'SITE_NOT_FOUND' | 'VALIDATION_ERROR' | 'SERVER_ERROR';
    readonly cause?: unknown | undefined;
    constructor(message: string, code: 'CONFIG_MISSING' | 'CONFIG_INVALID' | 'LOCKFILE_NOT_FOUND' | 'LOCKFILE_UNSUPPORTED' | 'LOCKFILE_PARSE_ERROR' | 'NETWORK_ERROR' | 'NETWORK_TIMEOUT' | 'SITE_NOT_FOUND' | 'VALIDATION_ERROR' | 'SERVER_ERROR', cause?: unknown | undefined);
}

type LockfileFilename = 'package-lock.json' | 'bun.lock' | 'bun.lockb' | 'yarn.lock' | 'pnpm-lock.yaml';
type DetectionStrategy = 'npm-lockfile' | 'node-modules-walk';
interface DetectedLockfile {
    ecosystem: 'npm';
    filePath: string;
    filename: LockfileFilename;
    strategy: DetectionStrategy;
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

declare const DEFAULT_ENDPOINT = "http://api.patchstack.com/monitor/pulse/manifest";
declare function buildEndpointUrl(base: string, siteUuid?: string | null): string;
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
    /**
     * When true, resolveConfig throws CONFIG_MISSING if no site UUID is configured.
     * Defaults to false: callers that can run without a UUID (the first `scan` after
     * `npm install`) just get `siteUuid: null` back and learn the UUID from the
     * server response.
     */
    requireSiteUuid?: boolean;
}
declare function resolveConfig(options: ResolveConfigOptions): Promise<Config>;
declare function writeConfigFile(cwd: string, config: ConfigFile): Promise<string>;
/**
 * Merge a new siteUuid into the existing `.patchstackrc.json` (or create it).
 * Preserves any `endpoint` / `timeoutMs` the user already wrote.
 */
declare function persistSiteUuid(cwd: string, siteUuid: string): Promise<string>;

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

export { type Config, DEFAULT_ENDPOINT, type Ecosystem, type Manifest, type PackageEntry, PatchstackError, type ScanAndReportOptions, type ScanAndReportResult, type StoreManifestResponse, buildEndpointUrl, buildWirePayload, compareVersions, detectLockfile, persistSiteUuid, postManifest, resolveConfig, scanAndReport, scanLockfile, writeConfigFile };
