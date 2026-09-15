import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { EnvLike } from './stack.js';
import type { Environment, EnvironmentSource } from './types.js';

/**
 * Where a scan is running, when nothing has said.
 *
 * A manifest is labelled with the environment it was built in, and Patchstack grades the site on that
 * label: a production build is contact with a live site, a local one is inventory. The label has to come
 * from evidence. Defaulting to `production` would make every first scan — the one that runs on a laptop
 * the moment the package is installed — a claim that the site was deployed and in contact, before anything
 * had been committed, let alone published.
 *
 * `production` is claimed only when the platform building this project says so through its OWN
 * variables. Some name the tier outright — Vercel's `VERCEL_ENV`, Netlify's `CONTEXT`, GitLab's
 * `CI_ENVIRONMENT_TIER` — and the same variable naming a preview makes the build `sandbox`: not the live
 * site, and known not to be. Others name only the branch: Cloudflare Pages and Workers Builds, AWS
 * Amplify, GitHub Actions, and GitLab without a tier. There the label rests on the branch NAME — `main`,
 * `master`, `production`, `prod`, `release` and `live` are taken to be the branch that goes live, any other
 * branch is a preview — which is an assumption, and the evidence line says so. A pull-request build
 * anywhere is `sandbox`: it is a check, not a deploy. A Replit Deployment is `production` and the Replit
 * workspace `sandbox`, each from Replit's own variable.
 *
 * Two things deliberately do not count. A generic CI marker on its own (`CI=true`, CircleCI, Jenkins,
 * Bitbucket, ...) proves automation, not deployment, and stays `local`. And a variable that is set but
 * empty is not set.
 *
 * The label decides more than the dashboard's wording. `mark-build` stamps the live-site marker only on a
 * `production` build, so a deployment mislabelled `local` ships its pages without it: the dashboard shows
 * the app as a working tree, and the widget on the live page behaves as though it were a dev build. A
 * laptop mislabelled `production` is worse — a deployed, connected site that does not exist — which is why
 * the default stays `local`, and why each discriminator reads its platform's own variables and nothing
 * else. `PATCHSTACK_ENVIRONMENT` remains the override for a platform this does not know.
 */

const set = (value: string | undefined): value is string => value !== undefined && value !== '';

export interface EnvironmentVerdict {
  environment: Environment;
  /** What decided it: variable names, plus the tier or branch value the decision rests on. */
  evidence: string;
}

interface Discriminator {
  platform: string;
  /** `production`, `sandbox` (a preview the platform names as such), or null when the platform is absent. */
  read: (env: EnvLike) => EnvironmentVerdict | null;
}

/**
 * Branch names taken to be the one that goes live, on platforms that name the branch but not the tier.
 *
 * Exact names only. A glob such as `release/*` would turn one team's naming convention into a guess
 * about every repository that has a branch of that shape.
 */
const PRODUCTION_BRANCHES: ReadonlySet<string> = new Set([
  'main',
  'master',
  'production',
  'prod',
  'release',
  'live',
]);

/**
 * The label a branch name alone supports: `production` for a name in {@link PRODUCTION_BRANCHES},
 * compared case-insensitively, `sandbox` for any other. The evidence says the decision rests on the name,
 * so the line the CLI prints reads as the assumption it is and points at what to override.
 */
export function environmentFromBranch(variable: string, branch: string): EnvironmentVerdict {
  return PRODUCTION_BRANCHES.has(branch.toLowerCase())
    ? { environment: 'production', evidence: `${variable}=${branch} (a production branch by name)` }
    : { environment: 'sandbox', evidence: `${variable}=${branch} (not a production branch by name)` };
}

/**
 * Each platform's own answer to "is this the production deployment?", read from that platform's
 * variables and nothing else. Hosting platforms first, CI runners last: a `vercel build` inside a GitHub
 * Actions job carries both sets of variables, and the tier belongs to the platform that will serve the
 * site.
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
  {
    // Pages and Workers Builds both name the branch and neither names the tier.
    platform: 'cloudflare',
    read: (env) => {
      if (set(env.CF_PAGES) && set(env.CF_PAGES_BRANCH)) {
        return environmentFromBranch('CF_PAGES_BRANCH', env.CF_PAGES_BRANCH);
      }
      if (set(env.WORKERS_CI) && set(env.WORKERS_CI_BRANCH)) {
        return environmentFromBranch('WORKERS_CI_BRANCH', env.WORKERS_CI_BRANCH);
      }
      return null;
    },
  },
  {
    // Amplify names the branch, and separately whether the build is a pull-request preview.
    platform: 'aws',
    read: (env) => {
      if (!set(env.AWS_APP_ID) || !set(env.AWS_BRANCH)) return null;
      return set(env.AWS_PULL_REQUEST_ID)
        ? { environment: 'sandbox', evidence: 'AWS_PULL_REQUEST_ID set (a pull-request preview)' }
        : environmentFromBranch('AWS_BRANCH', env.AWS_BRANCH);
    },
  },
  {
    // A Deployment build carries `REPLIT_DEPLOYMENT`; the workspace carries `REPL_ID` alone. Read here,
    // before the hosted-builder rule, so a workspace build in a Replit project is not its publish step.
    platform: 'replit',
    read: (env) => {
      if (set(env.REPLIT_DEPLOYMENT)) {
        return { environment: 'production', evidence: 'REPLIT_DEPLOYMENT set (a Replit Deployment build)' };
      }
      if (set(env.REPL_ID)) {
        return { environment: 'sandbox', evidence: 'REPL_ID set without REPLIT_DEPLOYMENT (the workspace)' };
      }
      return null;
    },
  },
  {
    // GitHub Pages deploys build here. A pull request checks out a merge ref whose name says nothing, so
    // the event is read first; a tag is a release; otherwise the branch name decides.
    platform: 'github-actions',
    read: (env) => {
      if (env.GITHUB_ACTIONS !== 'true') return null;
      if (set(env.GITHUB_EVENT_NAME) && env.GITHUB_EVENT_NAME.startsWith('pull_request')) {
        return { environment: 'sandbox', evidence: `GITHUB_EVENT_NAME=${env.GITHUB_EVENT_NAME} (a pull-request build)` };
      }
      if (env.GITHUB_REF_TYPE === 'tag') {
        return { environment: 'production', evidence: 'GITHUB_REF_TYPE=tag (a tag build)' };
      }
      if (!set(env.GITHUB_REF_NAME)) return null;
      return environmentFromBranch('GITHUB_REF_NAME', env.GITHUB_REF_NAME);
    },
  },
  {
    // The tier, when a job declares one, is GitLab's own word for it. Without one: a merge request is a
    // check, a tag is a release, the default branch goes live, and any other branch name decides.
    platform: 'gitlab-ci',
    read: (env) => {
      if (env.GITLAB_CI !== 'true') return null;
      if (set(env.CI_ENVIRONMENT_TIER)) {
        return env.CI_ENVIRONMENT_TIER === 'production'
          ? { environment: 'production', evidence: 'CI_ENVIRONMENT_TIER=production' }
          : { environment: 'sandbox', evidence: `CI_ENVIRONMENT_TIER=${env.CI_ENVIRONMENT_TIER}` };
      }
      if (set(env.CI_MERGE_REQUEST_IID)) {
        return { environment: 'sandbox', evidence: 'CI_MERGE_REQUEST_IID set (a merge-request build)' };
      }
      if (set(env.CI_COMMIT_TAG)) {
        return { environment: 'production', evidence: 'CI_COMMIT_TAG set (a tag build)' };
      }
      if (!set(env.CI_COMMIT_BRANCH)) return null;
      if (set(env.CI_DEFAULT_BRANCH) && env.CI_COMMIT_BRANCH === env.CI_DEFAULT_BRANCH) {
        return { environment: 'production', evidence: `CI_COMMIT_BRANCH=${env.CI_COMMIT_BRANCH} (the default branch)` };
      }
      return environmentFromBranch('CI_COMMIT_BRANCH', env.CI_COMMIT_BRANCH);
    },
  },
];

/**
 * Dependencies that only appear in a project a hosted builder generated and builds for itself.
 *
 * These are the platforms where the app never leaves the builder: the edit preview runs a DEV
 * SERVER, and `npm run build` runs when the owner publishes — or when the builder's agent is asked to
 * build, which nothing in the environment distinguishes. So a build hook firing in one of these
 * projects is normally the deploy, and the label is reported as assumed (`source: 'builder'`) so
 * Patchstack treats it as a report of a build until it sees that build on the live page.
 *
 * That matters where the platform sets no variable to read. Lovable sets none: without this, a Lovable
 * publish falls through every discriminator to `local`, and the site that is genuinely live reports as
 * a working tree — the marker is withheld from the published page, so the widget shows the connect
 * prompt to ordinary visitors instead of the report form. Replit does set variables, and its
 * discriminator above reads them first; the package rule covers a Replit project built somewhere
 * neither is present.
 *
 * The one case this reads wrong is a project exported to GitHub and then built on a developer's own
 * machine. It stays wrong only there: an export deployed through any platform listed above is decided
 * by that platform's own discriminator, which runs first and wins. `PATCHSTACK_ENVIRONMENT=local` is
 * the override for somebody building an export by hand.
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
  /** Whether a platform's variables or the hosted-builder rule decided it. Null for `local`. */
  source: Exclude<EnvironmentSource, 'override'> | null;
}

/**
 * @param builder A hosted builder this project belongs to, from {@link detectHostedBuilder}. Consulted
 *                only after every platform discriminator has declined, so a builder-made project
 *                deployed through Netlify, Vercel or Cloudflare is still decided by that platform.
 */
export function inferEnvironment(
  env: EnvLike = process.env,
  builder: string | null = null,
): InferredEnvironment {
  for (const discriminator of DISCRIMINATORS) {
    const verdict = discriminator.read(env);
    if (verdict !== null) {
      return {
        environment: verdict.environment,
        evidence: [`${discriminator.platform}: ${verdict.evidence}`],
        source: 'platform',
      };
    }
  }

  // Reported as `builder` so Patchstack knows this is the rule speaking and not the platform: the same
  // build runs when the builder's agent is asked to build without publishing.
  if (builder !== null) {
    return {
      environment: 'production',
      evidence: [`${builder}: a build in a ${builder} project is taken to be its publish step`],
      source: 'builder',
    };
  }

  return { environment: 'local', evidence: [], source: null };
}
