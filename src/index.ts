import { scanLockfile } from './parsers/index.js';
import { buildWirePayload } from './normalize.js';
import { postManifest } from './client.js';
import { persistApiKey, persistSiteUuid, resolveConfig } from './config.js';
import type { Config, Manifest, StoreManifestResponse } from './types.js';

export { scanLockfile, detectLockfile } from './parsers/index.js';
export { buildWirePayload, compareVersions } from './normalize.js';
export { postManifest, buildClaimUrl, buildEndpointUrl, DEFAULT_ENDPOINT } from './client.js';
export { persistApiKey, persistPulseAuth, persistSiteUuid, resolveConfig, writeConfigFile } from './config.js';
export {
  detectStack,
  collectHostingEnvKeys,
  isEmptyStack,
  type StackDescriptor,
} from './stack.js';
export {
  WIDGET_SCRIPT_URL,
  WIDGET_MARKER_ATTR,
  buildWidgetTag,
  ensureWidgetInHtml,
  ensureSourceWidget,
  findSourceShell,
  type WidgetEnsureAction,
  type WidgetEnsureResult,
  type SourceWidgetResult,
} from './widget.js';
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
  /**
   * Include each package's install location in the uploaded payload. Off by default: it widens what
   * leaves the machine, so it is an explicit choice rather than something an upgrade turns on.
   */
  installPaths?: boolean;
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
  // Reports the manifest, so it resolves what the manifest reports. A caller passing its own `config`
  // decides for itself: `siteUrl`/`siteName` are optional, and omitting them omits them from the push.
  const config = options.config ?? (await resolveConfig({ cwd, detectSiteIdentity: true }));
  const manifest = await scanLockfile(cwd);
  // Opt-in, matching the CLI: a library caller does not get a widened payload by upgrading either.
  const { payload, stats } = buildWirePayload(manifest, { installPaths: options.installPaths === true });
  const response = await postManifest(config, payload);

  // First-run convenience: if we didn't have a UUID and the server provisioned
  // one for us, persist it so subsequent runs target the same site.
  if (config.siteUuid === null && response.uuid !== undefined && response.uuid.length > 0) {
    await persistSiteUuid(cwd, response.uuid);
  }
  if (typeof response.api_key === 'string' && response.api_key.length > 0) {
    await persistApiKey(cwd, response.api_key);
  }

  return {
    manifest,
    response,
    duplicateNames: stats.duplicateNames,
    uniqueNames: stats.uniqueNames,
    totalEntries: stats.totalEntries,
  };
}
