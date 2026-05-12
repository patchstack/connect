import { scanLockfile } from './parsers/index.js';
import { buildWirePayload } from './normalize.js';
import { postManifest } from './client.js';
import { resolveConfig } from './config.js';
import type { Config, Manifest, StoreManifestResponse } from './types.js';

export { scanLockfile, detectLockfile } from './parsers/index.js';
export { buildWirePayload, compareVersions } from './normalize.js';
export { postManifest, buildEndpointUrl, DEFAULT_ENDPOINT } from './client.js';
export { resolveConfig, writeConfigFile } from './config.js';
export {
  PatchstackError,
  type Config,
  type Ecosystem,
  type Manifest,
  type PackageEntry,
  type StoreManifestResponse,
} from './types.js';

export interface ScanAndReportOptions {
  cwd?: string;
  config?: Config;
}

export interface ScanAndReportResult {
  manifest: Manifest;
  response: StoreManifestResponse;
  duplicateNames: string[];
  uniqueNames: number;
  totalEntries: number;
}

export async function scanAndReport(
  options: ScanAndReportOptions = {},
): Promise<ScanAndReportResult> {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? (await resolveConfig({ cwd }));
  const manifest = await scanLockfile(cwd);
  const { payload, stats } = buildWirePayload(manifest);
  const response = await postManifest(config, payload);
  return {
    manifest,
    response,
    duplicateNames: stats.duplicateNames,
    uniqueNames: stats.uniqueNames,
    totalEntries: stats.totalEntries,
  };
}
