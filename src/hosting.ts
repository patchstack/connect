import type { EnvLike } from './stack.js';

/**
 * Which hosting platform a build is running on, from the variables the platform sets.
 *
 * Reported alongside the manifest so the dashboard can say "hosted on Netlify" — and, when a later build
 * runs somewhere else, that the site moved. Only variable NAMES are read and only names are reported as
 * evidence; a value here would be a secret in a log line.
 *
 * Absence means nothing: a platform this list does not know reports no platform, not a wrong one. The
 * server has a second witness (the served page's headers) that covers platforms a build environment
 * cannot name, DigitalOcean's App Platform among them.
 */
export interface HostingDetection {
  platform: string | null;
  /** The variable names that decided it. Empty when no platform was recognised. */
  evidence: string[];
}

interface HostingRule {
  platform: string;
  /** Variable names that, present and non-empty, name this platform. */
  any: string[];
}

/**
 * Most specific first. Cloudflare Pages builds also carry generic CI variables and Vercel/Netlify never
 * carry each other's, so order only matters where one platform runs on another (a Cloudflare Pages
 * build of a Netlify-style project still says Cloudflare, because that is where it will be served).
 */
const RULES: readonly HostingRule[] = [
  { platform: 'netlify', any: ['NETLIFY', 'NETLIFY_BUILD_BASE', 'DEPLOY_PRIME_URL'] },
  { platform: 'vercel', any: ['VERCEL', 'VERCEL_ENV', 'VERCEL_URL'] },
  { platform: 'cloudflare', any: ['CF_PAGES', 'CF_PAGES_URL', 'CLOUDFLARE_ACCOUNT_ID'] },
  { platform: 'aws', any: ['AWS_APP_ID', 'AWS_LAMBDA_FUNCTION_NAME', 'AWS_EXECUTION_ENV'] },
  { platform: 'render', any: ['RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_URL'] },
  { platform: 'railway', any: ['RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_PROJECT_ID'] },
  { platform: 'fly', any: ['FLY_APP_NAME', 'FLY_REGION', 'FLY_ALLOC_ID'] },
  { platform: 'heroku', any: ['DYNO', 'HEROKU_APP_NAME'] },
  { platform: 'google-cloud', any: ['K_SERVICE', 'GAE_APPLICATION', 'GAE_SERVICE'] },
  { platform: 'deno-deploy', any: ['DENO_DEPLOYMENT_ID'] },
  { platform: 'azure', any: ['WEBSITE_SITE_NAME', 'WEBSITE_INSTANCE_ID'] },
];

const present = (env: EnvLike, name: string): boolean => {
  const value = env[name];
  return value !== undefined && value !== '';
};

export function detectHostingPlatform(env: EnvLike = process.env): HostingDetection {
  for (const rule of RULES) {
    const evidence = rule.any.filter((name) => present(env, name));
    if (evidence.length > 0) {
      return { platform: rule.platform, evidence };
    }
  }

  return { platform: null, evidence: [] };
}
