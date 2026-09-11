import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectHostedBuilder, inferEnvironment } from '../src/environment.js';

describe('inferEnvironment', () => {
  it('reports local from a machine with no deployment evidence', () => {
    expect(inferEnvironment({ HOME: '/Users/someone', PATH: '/usr/bin', SHELL: '/bin/zsh' })).toEqual({
      environment: 'local',
      evidence: [],
    });
  });

  it('reports production only when the platform itself says this build is production', () => {
    expect(inferEnvironment({ VERCEL: '1', VERCEL_ENV: 'production' })).toEqual({
      environment: 'production',
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
      evidence: ['vercel: VERCEL_ENV=preview'],
    });
    expect(inferEnvironment({ VERCEL: '1', VERCEL_ENV: 'development' }).environment).toBe('sandbox');
    expect(inferEnvironment({ NETLIFY: 'true', CONTEXT: 'deploy-preview' }).environment).toBe('sandbox');
    expect(inferEnvironment({ NETLIFY: 'true', CONTEXT: 'branch-deploy' }).environment).toBe('sandbox');
    expect(inferEnvironment({ RENDER: 'true', IS_PULL_REQUEST: 'true' }).environment).toBe('sandbox');
    expect(inferEnvironment({ RAILWAY_ENVIRONMENT_NAME: 'staging' }).environment).toBe('sandbox');
  });

  it('does not read a generic CI marker as production — it proves automation, not deployment', () => {
    expect(inferEnvironment({ CI: 'true' }).environment).toBe('local');
    expect(inferEnvironment({ CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' }).environment).toBe(
      'local',
    );
    expect(inferEnvironment({ GITLAB_CI: 'true' }).environment).toBe('local');
  });

  it("does not read a platform's presence as production without its own production signal", () => {
    // Cloudflare Pages names the branch but not which branch is production.
    expect(inferEnvironment({ CF_PAGES: '1', CF_PAGES_BRANCH: 'main', CF_PAGES_URL: 'https://x.pages.dev' }).environment).toBe(
      'local',
    );
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
    // These platforms set no variable we can read, and their edit preview is a dev server that never
    // runs a build — so the build hook firing IS the deploy. Without this a Lovable app's live site
    // reports as a working tree and the published page loses its marker.
    expect(inferEnvironment({ HOME: '/home/user' }, 'lovable')).toEqual({
      environment: 'production',
      evidence: ['lovable: a build in a lovable project is its publish step'],
    });
  });

  it('still lets the hosting platform decide, so an exported project is graded by where it deploys', () => {
    expect(inferEnvironment({ NETLIFY: 'true', CONTEXT: 'deploy-preview' }, 'lovable').environment).toBe('sandbox');
    expect(inferEnvironment({ VERCEL: '1', VERCEL_ENV: 'preview' }, 'lovable').environment).toBe('sandbox');
    expect(inferEnvironment({ VERCEL: '1', VERCEL_ENV: 'production' }, 'lovable').evidence).toEqual([
      'vercel: VERCEL_ENV=production',
    ]);
  });

  it('is unchanged for a project no builder made', () => {
    expect(inferEnvironment({ HOME: '/home/user' }, null).environment).toBe('local');
  });
});
