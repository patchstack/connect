import { describe, expect, it } from 'vitest';

import { inferEnvironment } from '../src/environment.js';

describe('inferEnvironment', () => {
  it('reports local from a machine with no deployment or CI evidence', () => {
    const inferred = inferEnvironment({ HOME: '/Users/someone', PATH: '/usr/bin', SHELL: '/bin/zsh' });
    expect(inferred).toEqual({ environment: 'local', evidence: [] });
  });

  it('reports production from a hosting platform build, and says which', () => {
    const inferred = inferEnvironment({ NETLIFY: 'true', URL: 'https://example.netlify.app', CONTEXT: 'production' });
    expect(inferred.environment).toBe('production');
    expect(inferred.evidence.join(' ')).toContain('netlify');
  });

  it('reports production from a bare CI marker', () => {
    expect(inferEnvironment({ CI: 'true' }).environment).toBe('production');
    expect(inferEnvironment({ GITHUB_ACTIONS: 'true' }).environment).toBe('production');
  });

  it('does not read a falsy CI marker as evidence', () => {
    expect(inferEnvironment({ CI: 'false' }).environment).toBe('local');
    expect(inferEnvironment({ CI: '0' }).environment).toBe('local');
    expect(inferEnvironment({ CI: '' }).environment).toBe('local');
  });

  it('reports production from hosting variables alone', () => {
    const inferred = inferEnvironment({ VERCEL: '1', VERCEL_ENV: 'production' });
    expect(inferred.environment).toBe('production');
    expect(inferred.evidence.join(' ')).toContain('VERCEL');
  });
});
