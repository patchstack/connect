import { join } from 'node:path';
import { createProtection, type Protection } from '@patchstack/connect/protect';
import { readHostedDeployment } from './deployment-metadata.js';
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

const deploymentFile = process.env.PATCHSTACK_DEPLOYMENT_FILE;
const deployment = deploymentFile === undefined ? undefined : readHostedDeployment(deploymentFile, siteUuid.toLowerCase());

// The configured service has its own transport so screening application egress cannot freeze rule updates.
const fetchAtStartup = globalThis.fetch.bind(globalThis);
const serviceFetch: typeof fetch = (input, init) => fetchAtStartup(input, { ...init, redirect: 'error' });

export const protection: Protection = await createProtection({
  siteUuid: siteUuid.toLowerCase(),
  buildId: deployment?.buildId,
  manifestChecksum: deployment?.manifestChecksum,
  startupRulesRetry: deployment !== undefined,
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
