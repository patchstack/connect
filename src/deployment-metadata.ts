import { readFileSync } from 'node:fs';

import { canonicalBuildId } from './build-id.js';

export interface HostedDeployment {
  siteUuid: string;
  buildId: string;
  manifestChecksum: string;
}

export function readHostedDeployment(file: string, siteUuid: string): HostedDeployment {
  let data: Partial<HostedDeployment> | null;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Patchstack could not read PATCHSTACK_DEPLOYMENT_FILE.');
  }
  const buildId = canonicalBuildId(data?.buildId);
  const checksum = data?.manifestChecksum;
  if (data?.siteUuid !== siteUuid || buildId === null || typeof checksum !== 'string' || !/^[0-9a-f]{12}$/.test(checksum)) {
    throw new Error('PATCHSTACK_DEPLOYMENT_FILE must contain a completed build for PATCHSTACK_SITE_UUID.');
  }
  return { siteUuid, buildId, manifestChecksum: checksum };
}
