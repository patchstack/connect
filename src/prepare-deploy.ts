import { resolve } from 'node:path';

import { computeManifestChecksum } from './checksum.js';
import { postManifest } from './client.js';
import { resolveConfig } from './config.js';
import { isCanonicalUuid, isCredential } from './endpoint-policy.js';
import { runMapDetailed } from './map-command.js';
import { buildWirePayload } from './normalize.js';
import { atomicWriteFileSync } from './safe-file.js';
import { scanLockfile } from './parsers/index.js';

export interface HostedDeployment {
  siteUuid: string;
  buildId: string;
  manifestChecksum: string;
}

export async function prepareDeploy(out: string | undefined): Promise<number> {
  const envSiteUuid = process.env.PATCHSTACK_SITE_UUID;
  const apiKey = process.env.PATCHSTACK_API_KEY;
  if (!out?.trim() || !isCanonicalUuid(envSiteUuid) || !isCredential(apiKey)) {
    console.error('prepare-deploy requires --out, PATCHSTACK_SITE_UUID and PATCHSTACK_API_KEY.');
    return 1;
  }

  const siteUuid = envSiteUuid.toLowerCase();
  const cwd = process.cwd();
  const file = resolve(cwd, out);
  // A failed rerun cannot leave a successful stamp for a different build at the selected path.
  atomicWriteFileSync(file, 'null\n', { encoding: 'utf8' });
  const config = {
    ...(await resolveConfig({ cwd, cliSiteUuid: siteUuid, detectSiteIdentity: true })),
    pulseAuth: apiKey,
    apiKey,
    claimToken: null,
  };
  const { payload } = buildWirePayload(await scanLockfile(cwd));
  const manifest = await postManifest(config, payload);
  if (!manifest.stored && manifest.reason !== 'duplicate') {
    console.error('prepare-deploy: Patchstack did not accept the dependency manifest.');
    return 1;
  }

  const map = await runMapDetailed(new Map([['upload', true]]), { config, declare: true });
  if (!map.buildId || (map.upload?.result !== 'stored' && map.upload?.result !== 'unchanged')) {
    console.error('prepare-deploy: no deployment metadata was produced for the input map.');
    return 1;
  }

  const deployment: HostedDeployment = {
    siteUuid,
    buildId: map.buildId,
    manifestChecksum: computeManifestChecksum(payload.packages),
  };
  atomicWriteFileSync(file, JSON.stringify(deployment, null, 2) + '\n', { encoding: 'utf8' });
  console.log('Patchstack deployment metadata is ready.');
  return 0;
}
