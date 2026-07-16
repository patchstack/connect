// Re-post the project's dependency manifest to Pulse — the runtime counterpart to the CLI's
// `scan`. The sandbox refresh loop (see runtime.js) calls this each tick so a dependency added
// after boot is reported without a restart: a targeted `npm install <pkg>` fires no npm lifecycle
// hook, so nothing else re-scans. Reuses the CLI scan pipeline; best-effort (the caller catches).
import { resolveConfig } from '../config.js';
import { scanLockfile } from '../parsers/index.js';
import { buildWirePayload } from '../normalize.js';
import { postManifest } from '../client.js';

/** Scan the lockfile under `cwd` and post the manifest to Pulse. No-op without a provisioned site. */
export async function reportManifest(cwd: string): Promise<void> {
  const config = await resolveConfig({ cwd });
  if (config.siteUuid === null || config.siteUuid.length === 0) {
    return;
  }
  const manifest = await scanLockfile(cwd);
  const { payload } = buildWirePayload(manifest);
  await postManifest(config, payload);
}
