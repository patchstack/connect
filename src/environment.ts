import type { EnvLike } from './stack.js';
import type { Environment } from './types.js';

/**
 * Where a scan is running, when nothing has said.
 *
 * A manifest is labelled with the environment it was built in, and Patchstack grades the site on that
 * label: a production build is contact with a live site, a local one is inventory. Defaulting to
 * `production` made every first scan — the one that runs on a laptop the moment the package is installed —
 * a claim that the site was deployed and in contact, before anything had been committed, let alone
 * published. The label has to come from evidence.
 *
 * `production` is claimed only when a hosting platform's OWN discriminator says this build is the
 * production one — Vercel's `VERCEL_ENV`, Netlify's `CONTEXT`, and so on. The same discriminator saying
 * preview makes the build `sandbox`: not the live site, and known not to be. Everything else is `local`.
 *
 * Three things deliberately do not count as production evidence. A generic CI marker (`CI`,
 * `GITHUB_ACTIONS`) proves automation, not deployment: the same runner builds pull requests and runs
 * tests. A hosting platform's variable with no production/preview discriminator names where the build
 * runs, not which deployment it is. And a variable that is set but empty is not set. Any of these read as
 * production recreates the false-live-site state this inference exists to end.
 *
 * The cost of a wrong answer is asymmetric, which is why the default is `local` and not the other way
 * round. A deployment mislabelled `local` still stamps its fingerprint into the page, and the live sighting
 * corrects the record on its own; a laptop mislabelled `production` is a deployed, connected site that does
 * not exist. `PATCHSTACK_ENVIRONMENT` remains the override for a platform this does not know.
 */

const set = (value: string | undefined): value is string => value !== undefined && value !== '';

interface Discriminator {
  platform: string;
  /** `production`, `sandbox` (a preview the platform names as such), or null when the platform is absent. */
  read: (env: EnvLike) => { environment: Environment; evidence: string } | null;
}

/**
 * Each platform's own answer to "is this the production deployment?". Only platforms that answer are
 * listed: Cloudflare Pages exposes a branch name but no way to know which branch is production, so a
 * Pages build stays `local` unless `PATCHSTACK_ENVIRONMENT` says otherwise.
 */
const DISCRIMINATORS: readonly Discriminator[] = [
  {
    platform: 'vercel',
    read: (env) => {
      if (!set(env.VERCEL) || !set(env.VERCEL_ENV)) return null;
      return env.VERCEL_ENV === 'production'
        ? { environment: 'production', evidence: 'VERCEL_ENV=production' }
        : { environment: 'sandbox', evidence: `VERCEL_ENV=${env.VERCEL_ENV}` };
    },
  },
  {
    platform: 'netlify',
    read: (env) => {
      if (env.NETLIFY !== 'true' || !set(env.CONTEXT)) return null;
      return env.CONTEXT === 'production'
        ? { environment: 'production', evidence: 'CONTEXT=production' }
        : { environment: 'sandbox', evidence: `CONTEXT=${env.CONTEXT}` };
    },
  },
  {
    platform: 'render',
    read: (env) => {
      if (env.RENDER !== 'true') return null;
      return env.IS_PULL_REQUEST === 'true'
        ? { environment: 'sandbox', evidence: 'IS_PULL_REQUEST=true' }
        : { environment: 'production', evidence: 'RENDER=true, not a pull request' };
    },
  },
  {
    platform: 'railway',
    read: (env) => {
      if (!set(env.RAILWAY_ENVIRONMENT_NAME)) return null;
      return env.RAILWAY_ENVIRONMENT_NAME === 'production'
        ? { environment: 'production', evidence: 'RAILWAY_ENVIRONMENT_NAME=production' }
        : { environment: 'sandbox', evidence: `RAILWAY_ENVIRONMENT_NAME=${env.RAILWAY_ENVIRONMENT_NAME}` };
    },
  },
];

export interface InferredEnvironment {
  environment: Environment;
  /** What decided it, for the line the CLI prints. Empty for `local`, which is decided by absence. */
  evidence: string[];
}

export function inferEnvironment(env: EnvLike = process.env): InferredEnvironment {
  for (const discriminator of DISCRIMINATORS) {
    const verdict = discriminator.read(env);
    if (verdict !== null) {
      return { environment: verdict.environment, evidence: [`${discriminator.platform}: ${verdict.evidence}`] };
    }
  }

  return { environment: 'local', evidence: [] };
}
