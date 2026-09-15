import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectHostedBuilder, environmentFromBranch, inferEnvironment } from '../src/environment.js';

describe('inferEnvironment', () => {
  it('reports local from a machine with no deployment evidence', () => {
    expect(inferEnvironment({ HOME: '/Users/someone', PATH: '/usr/bin', SHELL: '/bin/zsh' })).toEqual({
      environment: 'local',
      source: null,
      evidence: [],
    });
  });

  it('reports production only when the platform itself says this build is production', () => {
    expect(inferEnvironment({ VERCEL: '1', VERCEL_ENV: 'production' })).toEqual({
      environment: 'production',
      source: 'platform',
      evidence: ['vercel: VERCEL_ENV=production'],
    });
    expect(inferEnvironment({ NETLIFY: 'true', CONTEXT: 'production', URL: 'https://x.netlify.app' }).environment).toBe(
      'production',
    );
    expect(inferEnvironment({ RENDER: 'true', IS_PULL_REQUEST: 'false' }).environment).toBe('production');
    expect(inferEnvironment({ RAILWAY_ENVIRONMENT_NAME: 'production' }).environment).toBe('production');
  });

  it('reports a preview the platform names as such as sandbox, never production', () => {
    expect(inferEnvironment({ VERCEL: '1', VERCEL_ENV: 'preview' })).toEqual({
      environment: 'sandbox',
      source: 'platform',
      evidence: ['vercel: VERCEL_ENV=preview'],
    });
    expect(inferEnvironment({ VERCEL: '1', VERCEL_ENV: 'development' }).environment).toBe('sandbox');
    expect(inferEnvironment({ NETLIFY: 'true', CONTEXT: 'deploy-preview' }).environment).toBe('sandbox');
    expect(inferEnvironment({ NETLIFY: 'true', CONTEXT: 'branch-deploy' }).environment).toBe('sandbox');
    expect(inferEnvironment({ RENDER: 'true', IS_PULL_REQUEST: 'true' }).environment).toBe('sandbox');
    expect(inferEnvironment({ RAILWAY_ENVIRONMENT_NAME: 'staging' }).environment).toBe('sandbox');
  });

  it('decides a Cloudflare Pages build by its branch name, and says so', () => {
    expect(
      inferEnvironment({ CF_PAGES: '1', CF_PAGES_BRANCH: 'main', CF_PAGES_URL: 'https://x.pages.dev' }),
    ).toEqual({
      environment: 'production',
      source: 'platform',
      evidence: ['cloudflare: CF_PAGES_BRANCH=main (a production branch by name)'],
    });
    expect(inferEnvironment({ CF_PAGES: '1', CF_PAGES_BRANCH: 'staging' })).toEqual({
      environment: 'sandbox',
      source: 'platform',
      evidence: ['cloudflare: CF_PAGES_BRANCH=staging (not a production branch by name)'],
    });
  });

  it('decides a Cloudflare Workers Builds build by its branch name', () => {
    expect(inferEnvironment({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' })).toEqual({
      environment: 'production',
      source: 'platform',
      evidence: ['cloudflare: WORKERS_CI_BRANCH=main (a production branch by name)'],
    });
    expect(inferEnvironment({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'feature/login' }).environment).toBe('sandbox');
  });

  it('decides an AWS Amplify build by its branch name, and a pull-request preview as sandbox', () => {
    expect(inferEnvironment({ AWS_APP_ID: 'd1abc', AWS_BRANCH: 'main' })).toEqual({
      environment: 'production',
      source: 'platform',
      evidence: ['aws: AWS_BRANCH=main (a production branch by name)'],
    });
    expect(inferEnvironment({ AWS_APP_ID: 'd1abc', AWS_BRANCH: 'dev' }).environment).toBe('sandbox');
    expect(inferEnvironment({ AWS_APP_ID: 'd1abc', AWS_BRANCH: 'main', AWS_PULL_REQUEST_ID: '42' })).toEqual({
      environment: 'sandbox',
      source: 'platform',
      evidence: ['aws: AWS_PULL_REQUEST_ID set (a pull-request preview)'],
    });
  });

  it('decides a GitHub Actions build by its event, then its tag, then its branch name', () => {
    const push = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'branch' };
    expect(inferEnvironment({ ...push, GITHUB_REF_NAME: 'main' })).toEqual({
      environment: 'production',
      source: 'platform',
      evidence: ['github-actions: GITHUB_REF_NAME=main (a production branch by name)'],
    });
    expect(inferEnvironment({ ...push, GITHUB_REF_NAME: 'feature-x' }).environment).toBe('sandbox');
    // A pull request checks out a merge ref, so the event is read before the ref name can mislead.
    expect(
      inferEnvironment({ ...push, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF_NAME: '12/merge' }),
    ).toEqual({
      environment: 'sandbox',
      source: 'platform',
      evidence: ['github-actions: GITHUB_EVENT_NAME=pull_request (a pull-request build)'],
    });
    expect(
      inferEnvironment({ ...push, GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REF_NAME: 'main' }).environment,
    ).toBe('sandbox');
    expect(inferEnvironment({ ...push, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.0' })).toEqual({
      environment: 'production',
      source: 'platform',
      evidence: ['github-actions: GITHUB_REF_TYPE=tag (a tag build)'],
    });
  });

  it('decides a GitLab CI build by its environment tier, then its merge request, then its branch', () => {
    expect(
      inferEnvironment({ GITLAB_CI: 'true', CI_ENVIRONMENT_TIER: 'production', CI_COMMIT_BRANCH: 'anything' }),
    ).toEqual({
      environment: 'production',
      source: 'platform',
      evidence: ['gitlab-ci: CI_ENVIRONMENT_TIER=production'],
    });
    expect(inferEnvironment({ GITLAB_CI: 'true', CI_ENVIRONMENT_TIER: 'staging', CI_COMMIT_BRANCH: 'main' })).toEqual({
      environment: 'sandbox',
      source: 'platform',
      evidence: ['gitlab-ci: CI_ENVIRONMENT_TIER=staging'],
    });
    expect(inferEnvironment({ GITLAB_CI: 'true', CI_MERGE_REQUEST_IID: '7', CI_COMMIT_BRANCH: 'main' })).toEqual({
      environment: 'sandbox',
      source: 'platform',
      evidence: ['gitlab-ci: CI_MERGE_REQUEST_IID set (a merge-request build)'],
    });
    expect(inferEnvironment({ GITLAB_CI: 'true', CI_COMMIT_TAG: 'v1.2.0' })).toEqual({
      environment: 'production',
      source: 'platform',
      evidence: ['gitlab-ci: CI_COMMIT_TAG set (a tag build)'],
    });
    expect(inferEnvironment({ GITLAB_CI: 'true', CI_COMMIT_BRANCH: 'trunk', CI_DEFAULT_BRANCH: 'trunk' })).toEqual({
      environment: 'production',
      source: 'platform',
      evidence: ['gitlab-ci: CI_COMMIT_BRANCH=trunk (the default branch)'],
    });
    expect(inferEnvironment({ GITLAB_CI: 'true', CI_COMMIT_BRANCH: 'main', CI_DEFAULT_BRANCH: 'trunk' })).toEqual({
      environment: 'production',
      source: 'platform',
      evidence: ['gitlab-ci: CI_COMMIT_BRANCH=main (a production branch by name)'],
    });
    expect(inferEnvironment({ GITLAB_CI: 'true', CI_COMMIT_BRANCH: 'feature-x', CI_DEFAULT_BRANCH: 'main' }).environment).toBe(
      'sandbox',
    );
  });

  it('reads a Replit workspace as sandbox and a Replit Deployment as production', () => {
    expect(inferEnvironment({ REPL_ID: 'abc', REPL_SLUG: 'my-app' })).toEqual({
      environment: 'sandbox',
      source: 'platform',
      evidence: ['replit: REPL_ID set without REPLIT_DEPLOYMENT (the workspace)'],
    });
    expect(inferEnvironment({ REPL_ID: 'abc', REPLIT_DEPLOYMENT: '1' })).toEqual({
      environment: 'production',
      source: 'platform',
      evidence: ['replit: REPLIT_DEPLOYMENT set (a Replit Deployment build)'],
    });
  });

  it('does not read a generic CI marker as production — it proves automation, not deployment', () => {
    expect(inferEnvironment({ CI: 'true' }).environment).toBe('local');
    expect(inferEnvironment({ CI: 'true', CIRCLECI: 'true', CIRCLE_BRANCH: 'main' }).environment).toBe('local');
    expect(inferEnvironment({ CI: 'true', JENKINS_URL: 'https://ci.example.test/', BRANCH_NAME: 'main' }).environment).toBe(
      'local',
    );
    expect(inferEnvironment({ CI: 'true', BITBUCKET_BRANCH: 'main' }).environment).toBe('local');
  });

  it("does not read a platform's presence as production without its own production signal", () => {
    // Cloudflare Pages and Workers Builds without a branch name have nothing to decide on.
    expect(inferEnvironment({ CF_PAGES: '1', CF_PAGES_URL: 'https://x.pages.dev' }).environment).toBe('local');
    expect(inferEnvironment({ WORKERS_CI: '1' }).environment).toBe('local');
    // Amplify naming the app but not the branch, likewise.
    expect(inferEnvironment({ AWS_APP_ID: 'd1abc' }).environment).toBe('local');
    // A Vercel build with the discriminator missing is not a production build.
    expect(inferEnvironment({ VERCEL: '1' }).environment).toBe('local');
    // Netlify without its context, likewise.
    expect(inferEnvironment({ NETLIFY: 'true' }).environment).toBe('local');
  });

  it('treats a variable that is set but empty as not set', () => {
    expect(inferEnvironment({ NETLIFY: '' }).environment).toBe('local');
    expect(inferEnvironment({ NETLIFY: '', CONTEXT: 'production' }).environment).toBe('local');
    expect(inferEnvironment({ VERCEL: '', VERCEL_ENV: 'production' }).environment).toBe('local');
    expect(inferEnvironment({ VERCEL: '1', VERCEL_ENV: '' }).environment).toBe('local');
    expect(inferEnvironment({ RAILWAY_ENVIRONMENT_NAME: '' }).environment).toBe('local');
    expect(inferEnvironment({ CF_PAGES: '1', CF_PAGES_BRANCH: '' }).environment).toBe('local');
    expect(inferEnvironment({ AWS_APP_ID: 'd1abc', AWS_BRANCH: '' }).environment).toBe('local');
    expect(inferEnvironment({ GITHUB_ACTIONS: 'true', GITHUB_REF_NAME: '' }).environment).toBe('local');
    expect(inferEnvironment({ GITLAB_CI: 'true', CI_ENVIRONMENT_TIER: '', CI_COMMIT_BRANCH: '' }).environment).toBe('local');
    expect(inferEnvironment({ REPL_ID: '', REPLIT_DEPLOYMENT: '' }).environment).toBe('local');
  });
});

describe('environmentFromBranch', () => {
  it('names the branches taken to go live, exactly and regardless of case', () => {
    for (const branch of ['main', 'master', 'production', 'prod', 'release', 'live', 'Main', 'MASTER']) {
      expect(environmentFromBranch('CF_PAGES_BRANCH', branch).environment).toBe('production');
    }
  });

  it('reads any other branch as a preview, with no pattern matching', () => {
    for (const branch of ['staging', 'develop', 'feature/login', 'release/1.2', 'production-hotfix', 'main-2']) {
      expect(environmentFromBranch('CF_PAGES_BRANCH', branch).environment).toBe('sandbox');
    }
  });

  it('says the decision rests on the name, so a reader knows it is an assumption', () => {
    expect(environmentFromBranch('AWS_BRANCH', 'main').evidence).toBe('AWS_BRANCH=main (a production branch by name)');
    expect(environmentFromBranch('AWS_BRANCH', 'staging').evidence).toBe(
      'AWS_BRANCH=staging (not a production branch by name)',
    );
  });
});

describe('detectHostedBuilder', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ps-builder-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const project = (pkg: Record<string, unknown>): string => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    return dir;
  };

  it('names the builder from the tooling it ships', () => {
    expect(detectHostedBuilder(project({ devDependencies: { 'lovable-tagger': '^1.1.0' } }))).toBe('lovable');
    expect(detectHostedBuilder(project({ devDependencies: { '@lovable.dev/vite-tanstack-config': '^1' } }))).toBe(
      'lovable',
    );
    expect(detectHostedBuilder(project({ devDependencies: { '@replit/vite-plugin-cartographer': '^1' } }))).toBe(
      'replit',
    );
  });

  it('names no builder for an ordinary project', () => {
    expect(detectHostedBuilder(project({ dependencies: { react: '^18' }, devDependencies: { vite: '^5' } }))).toBeNull();
  });

  it('names no builder when there is no manifest to read', () => {
    expect(detectHostedBuilder(dir)).toBeNull();
  });
});

describe('inferEnvironment with a hosted builder', () => {
  it('treats a build in a builder project as its publish step', () => {
    // Lovable sets no variable we can read, and its edit preview is a dev server that never runs a
    // build — so the build hook firing IS the deploy. Without this a Lovable app's live site reports as
    // a working tree and the published page loses its marker.
    expect(inferEnvironment({ HOME: '/home/user' }, 'lovable')).toEqual({
      environment: 'production',
      // Said to be the rule's word, not a platform's: the same build runs when the builder's agent is
      // asked to build without publishing, and Patchstack grades an assumed label as a report.
      source: 'builder',
      evidence: ['lovable: a build in a lovable project is taken to be its publish step'],
    });
  });

  it('still lets the hosting platform decide, so an exported project is graded by where it deploys', () => {
    expect(inferEnvironment({ NETLIFY: 'true', CONTEXT: 'deploy-preview' }, 'lovable').environment).toBe('sandbox');
    expect(inferEnvironment({ VERCEL: '1', VERCEL_ENV: 'preview' }, 'lovable').environment).toBe('sandbox');
    expect(inferEnvironment({ VERCEL: '1', VERCEL_ENV: 'production' }, 'lovable').evidence).toEqual([
      'vercel: VERCEL_ENV=production',
    ]);
  });

  it('lets Cloudflare decide for a Lovable project deployed through Cloudflare Pages, not the builder', () => {
    expect(inferEnvironment({ CF_PAGES: '1', CF_PAGES_BRANCH: 'preview' }, 'lovable')).toEqual({
      environment: 'sandbox',
      source: 'platform',
      evidence: ['cloudflare: CF_PAGES_BRANCH=preview (not a production branch by name)'],
    });
    expect(inferEnvironment({ CF_PAGES: '1', CF_PAGES_BRANCH: 'main' }, 'lovable').evidence).toEqual([
      'cloudflare: CF_PAGES_BRANCH=main (a production branch by name)',
    ]);
  });

  it('reads a Replit workspace as sandbox even in a Replit project, and an export built elsewhere as its publish step', () => {
    expect(inferEnvironment({ REPL_ID: 'abc' }, 'replit').environment).toBe('sandbox');
    expect(inferEnvironment({ REPL_ID: 'abc', REPLIT_DEPLOYMENT: '1' }, 'replit').environment).toBe('production');
    expect(inferEnvironment({ HOME: '/home/user' }, 'replit').environment).toBe('production');
  });

  it('is unchanged for a project no builder made', () => {
    expect(inferEnvironment({ HOME: '/home/user' }, null).environment).toBe('local');
  });
});
