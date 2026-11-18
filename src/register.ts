import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProtection, type Protection } from '@patchstack/connect/protect';
import { canonicalBuildId } from './build-id.js';
import type { HostedDeployment } from './prepare-deploy.js';
import { isCanonicalUuid, isCredential, safeRemoteUrl } from './endpoint-policy.js';

const siteUuid = process.env.PATCHSTACK_SITE_UUID;
const apiKey = process.env.PATCHSTACK_API_KEY;
const mode = process.env.PATCHSTACK_MODE;
const configuredRulesUrl = process.env.PATCHSTACK_PULSE_RULES_URL;
const pulseRulesUrl = safeRemoteUrl(configuredRulesUrl)?.replace(/\/+$/, '');

if (!isCanonicalUuid(siteUuid)) throw new Error('Patchstack preload requires PATCHSTACK_SITE_UUID.');
if (!isCredential(apiKey)) throw new Error('Patchstack preload requires a valid PATCHSTACK_API_KEY.');
if (mode !== undefined && mode !== 'block' && mode !== 'dry-run') {
  throw new Error('PATCHSTACK_MODE must be block or dry-run.');
}
if (configuredRulesUrl !== undefined && (!pulseRulesUrl || /[?#]/.test(pulseRulesUrl))) {
  throw new Error('PATCHSTACK_PULSE_RULES_URL must be an HTTPS or loopback HTTP base URL without a query or fragment.');
}

function deploymentForSite(site: string): HostedDeployment | undefined {
  const file = process.env.PATCHSTACK_DEPLOYMENT_FILE;
  if (file === undefined) return undefined;
  let deployment: Partial<HostedDeployment> | null;
  try {
    deployment = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Patchstack could not read PATCHSTACK_DEPLOYMENT_FILE.');
  }
  const buildId = canonicalBuildId(deployment?.buildId);
  const manifestChecksum = deployment?.manifestChecksum;
  if (
    deployment?.siteUuid !== site || buildId === null
    || typeof manifestChecksum !== 'string' || !/^[0-9a-f]{12}$/.test(manifestChecksum)
  ) {
    throw new Error('PATCHSTACK_DEPLOYMENT_FILE must contain a completed build for PATCHSTACK_SITE_UUID.');
  }
  return { siteUuid: site, buildId, manifestChecksum };
}

const deployment = deploymentForSite(siteUuid.toLowerCase());
// The configured service has its own transport so screening application egress cannot freeze rule updates.
const fetchAtStartup = globalThis.fetch.bind(globalThis);
const serviceFetch: typeof fetch = (input, init) => fetchAtStartup(input, { ...init, redirect: 'error' });

export const protection: Protection = await createProtection({
  siteUuid: siteUuid.toLowerCase(),
  buildId: deployment?.buildId,
  manifestChecksum: deployment?.manifestChecksum,
  apiKey,
  pulseAuth: apiKey,
  pulseRulesUrl,
  fetchImpl: serviceFetch,
  ruleFetchImpl: serviceFetch,
  mode: mode ?? 'block',
  egress: process.env.PATCHSTACK_EGRESS === '1',
  refreshMs: process.env.PATCHSTACK_ENVIRONMENT === 'sandbox' ? 15_000 : 300_000,
  reportManifest: false,
  cacheDir: join(process.cwd(), '.patchstack'),
});

export const expressProtection = protection.express({ screenResponses: true });
