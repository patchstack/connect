import { join } from 'node:path';
import { createProtection, type Protection } from '@patchstack/connect/protect';
import { isCanonicalUuid, isCredential, safeRemoteUrl } from './endpoint-policy.js';

const siteUuid = process.env.PATCHSTACK_SITE_UUID;
const apiKey = process.env.PATCHSTACK_API_KEY;
const mode = process.env.PATCHSTACK_MODE;
const pulseRulesUrl = process.env.PATCHSTACK_PULSE_RULES_URL;

if (!isCanonicalUuid(siteUuid)) throw new Error('Patchstack preload requires PATCHSTACK_SITE_UUID.');
if (!isCredential(apiKey)) throw new Error('Patchstack preload requires a valid PATCHSTACK_API_KEY.');
if (mode !== undefined && mode !== 'block' && mode !== 'dry-run') {
  throw new Error('PATCHSTACK_MODE must be block or dry-run.');
}
if (pulseRulesUrl !== undefined && safeRemoteUrl(pulseRulesUrl) === null) {
  throw new Error('PATCHSTACK_PULSE_RULES_URL must use HTTPS or a loopback HTTP URL.');
}

export const protection: Protection = await createProtection({
  siteUuid,
  apiKey,
  pulseAuth: apiKey,
  pulseRulesUrl,
  mode: mode ?? 'block',
  egress: process.env.PATCHSTACK_EGRESS === '1',
  refreshMs: process.env.PATCHSTACK_ENVIRONMENT === 'sandbox' ? 15_000 : 300_000,
  reportManifest: false,
  cacheDir: join(process.cwd(), '.patchstack'),
});

export const expressProtection = protection.express({ screenResponses: true });
