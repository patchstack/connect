import { readFileSync } from 'node:fs';
import path from 'node:path';

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

/**
 * Dependencies that only appear in a project a hosted builder generated and builds for itself.
 *
 * These are the platforms where the app never leaves the builder: the edit preview runs a DEV
 * SERVER, and `npm run build` runs only when the owner publishes. So a build hook firing in one of
 * these projects IS the deploy — there is no other moment it could be.
 *
 * That matters because none of these platforms sets a hosting variable we could read. Without this,
 * a Lovable publish falls through every discriminator to `local`, and the site that is genuinely
 * live reports as a working tree: the marker is withheld from the published page, so the widget
 * shows the connect prompt to ordinary visitors instead of the report form.
 *
 * The one case this reads wrong is a project exported to GitHub and then built on a developer's own
 * machine. It stays wrong only there: an export that is deployed through Netlify, Vercel, Render or
 * Railway is decided by that platform's own discriminator above, which runs first and wins.
 * `PATCHSTACK_ENVIRONMENT=local` is the override for somebody building an export by hand.
 */
const HOSTED_BUILDER_PACKAGES: readonly { builder: string; exact: readonly string[]; prefixes: readonly string[] }[] = [
  // `lovable-tagger` covers projects from before ~Aug 2026; current templates ship the
  // `@lovable.dev/*` scoped tooling instead.
  { builder: 'lovable', exact: ['lovable-tagger'], prefixes: ['@lovable.dev/'] },
  { builder: 'replit', exact: [], prefixes: ['@replit/'] },
];

/**
 * The hosted builder this project belongs to, from its declared dependencies, or null.
 *
 * Reads `package.json` rather than the lockfile: the question is what this project is, which its own
 * manifest answers, and this runs before the lockfile scan in some callers. Best-effort by design —
 * an unreadable or absent manifest simply names no builder.
 */
export function detectHostedBuilder(cwd: string): string | null {
  let declared: Record<string, unknown>;
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return null;
  }

  const names = Object.keys(declared);
  for (const rule of HOSTED_BUILDER_PACKAGES) {
    const hit = names.some(
      (name) => rule.exact.includes(name) || rule.prefixes.some((prefix) => name.startsWith(prefix)),
    );
    if (hit) return rule.builder;
  }

  return null;
}

export interface InferredEnvironment {
  environment: Environment;
  /** What decided it, for the line the CLI prints. Empty for `local`, which is decided by absence. */
  evidence: string[];
}

/**
 * @param builder A hosted builder this project belongs to, from {@link detectHostedBuilder}. Consulted
 *                only after every platform discriminator has declined, so a builder-made project
 *                deployed through Netlify or Vercel is still decided by that platform.
 */
export function inferEnvironment(
  env: EnvLike = process.env,
  builder: string | null = null,
): InferredEnvironment {
  for (const discriminator of DISCRIMINATORS) {
    const verdict = discriminator.read(env);
    if (verdict !== null) {
      return { environment: verdict.environment, evidence: [`${discriminator.platform}: ${verdict.evidence}`] };
    }
  }

  if (builder !== null) {
    return {
      environment: 'production',
      evidence: [`${builder}: a build in a ${builder} project is its publish step`],
    };
  }

  return { environment: 'local', evidence: [] };
}
