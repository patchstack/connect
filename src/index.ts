import { scanLockfile } from './parsers/index.js';
import { buildWirePayload } from './normalize.js';
import { postManifest } from './client.js';
import { persistSiteUuid, resolveConfig } from './config.js';
import type { Config, Manifest, StoreManifestResponse } from './types.js';

export { scanLockfile, detectLockfile } from './parsers/index.js';
export { buildWirePayload, compareVersions } from './normalize.js';
export { postManifest, buildClaimUrl, buildEndpointUrl, DEFAULT_ENDPOINT } from './client.js';
export { persistSiteUuid, resolveConfig, writeConfigFile } from './config.js';
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

  // First-run convenience: if we didn't have a UUID and the server provisioned
  // one for us, persist it so subsequent runs target the same site.
  if (config.siteUuid === null && response.uuid !== undefined && response.uuid.length > 0) {
    await persistSiteUuid(cwd, response.uuid);
  }

  return {
    manifest,
    response,
    duplicateNames: stats.duplicateNames,
    uniqueNames: stats.uniqueNames,
    totalEntries: stats.totalEntries,
  };
}
