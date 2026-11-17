import { setTimeout as delay } from 'node:timers/promises';

import { probeActivation } from './activation-check.js';
import { readHostedDeployment, type HostedDeployment } from './deployment-metadata.js';
import { isCanonicalUuid, isCredential, safeRemoteUrl } from './endpoint-policy.js';

function waitingFor(
  status: Record<string, unknown> | null,
  expected: HostedDeployment,
  requireBlock: boolean,
): string | null {
  if (!status || status.siteUuid !== expected.siteUuid) return 'The selected URL did not prove activation for this site.';
  if (status.buildId !== expected.buildId || status.manifestChecksum !== expected.manifestChecksum) {
    return 'The guard is serving different deployment metadata.';
  }
  const source = status.source as { ok?: boolean } | undefined;
  if (source?.ok !== true || status.matched !== true) return 'The rules service has not confirmed this build.';
  if (status.mapRules !== 'ready') return 'The rules service has not marked this build ready.';
  if (status.mode !== 'block' && status.mode !== 'dry-run') return 'The guard did not report its enforcement mode.';
  if (requireBlock && (status.mode !== 'block' || status.devSync === true)) return 'The guard is not ready for blocking mode.';
  return null;
}

export async function verifyDeploy(url: string | undefined, seconds: number, requireBlock: boolean): Promise<number> {
  const target = safeRemoteUrl(url ?? process.env.PATCHSTACK_READINESS_URL);
  if (!target || new URL(target).hash) {
    console.error('verify-deploy requires --url or PATCHSTACK_READINESS_URL with HTTPS or loopback HTTP, without credentials or a fragment.');
    return 1;
  }
  const siteUuid = process.env.PATCHSTACK_SITE_UUID;
  const secret = process.env.PATCHSTACK_API_KEY;
  const file = process.env.PATCHSTACK_DEPLOYMENT_FILE;
  if (!file?.trim() || !isCanonicalUuid(siteUuid) || !isCredential(secret)) {
    console.error('verify-deploy requires PATCHSTACK_DEPLOYMENT_FILE, PATCHSTACK_SITE_UUID and PATCHSTACK_API_KEY.');
    return 1;
  }
  const expected = readHostedDeployment(file, siteUuid.toLowerCase());
  const deadline = performance.now() + seconds * 1000;
  let reason = 'The selected URL did not answer the readiness check.';
  for (;;) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) break;

    let status: Record<string, unknown> | null;
    try {
      status = await probeActivation(target, secret, AbortSignal.timeout(Math.min(remaining, 5000)));
    } catch {
      status = null;
    }
    const waiting = waitingFor(status, expected, requireBlock);
    if (waiting === null) {
      console.log(`Deployment ready at the checked URL (${status?.mode}).`);
      return 0;
    }
    reason = waiting;
    await delay(Math.max(0, Math.min(1000, deadline - performance.now())));
  }
  console.error(`Deployment readiness timed out. ${reason}`);
  return 1;
}
