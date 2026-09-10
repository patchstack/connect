import { detectSiteUrl } from './site-url.js';
import { collectHostingEnvKeys, type EnvLike } from './stack.js';
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
 * `production` is claimed only on positive evidence that this process is a deployment or CI build: a
 * hosting platform's variables, a CI marker, or a production URL the platform exposes. A developer's
 * machine has none of these, and reports as `local`. A hosted builder's sandbox says `sandbox` explicitly,
 * as it always has.
 *
 * The cost of a wrong answer is asymmetric, which is why the default is `local` and not the other way
 * round. A deployment mislabelled `local` still stamps its fingerprint into the page, and the live sighting
 * corrects the record on its own; a laptop mislabelled `production` is a deployed, connected site that does
 * not exist.
 */

/** Variables that mark a CI or platform build, beyond the hosting patterns the stack descriptor reads. */
const CI_MARKERS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'TF_BUILD',
  'CODEBUILD_BUILD_ID',
  'BITBUCKET_BUILD_NUMBER',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'DRONE',
  'SEMAPHORE',
  'APPVEYOR',
  'REPL_ID',
  'REPLIT_DEPLOYMENT',
];

const truthy = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';

export interface InferredEnvironment {
  environment: Environment;
  /** What decided it, for the line the CLI prints. Empty for `local`, which is decided by absence. */
  evidence: string[];
}

export function inferEnvironment(env: EnvLike = process.env): InferredEnvironment {
  const evidence: string[] = [];

  const url = detectSiteUrl(env as NodeJS.ProcessEnv);
  if (url !== null) evidence.push(`${url.platform} build (${url.url})`);

  const hosting = collectHostingEnvKeys(env);
  if (hosting.length > 0) evidence.push(`hosting variables: ${hosting.slice(0, 3).join(', ')}`);

  const ci = CI_MARKERS.filter((marker) => truthy(env[marker]));
  if (ci.length > 0) evidence.push(`CI: ${ci.slice(0, 2).join(', ')}`);

  return evidence.length > 0
    ? { environment: 'production', evidence }
    : { environment: 'local', evidence: [] };
}
