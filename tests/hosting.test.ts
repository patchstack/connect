import { describe, expect, it } from 'vitest';

import { detectHostingPlatform } from '../src/hosting.js';

describe('detectHostingPlatform', () => {
  it('names the platform from the variables it sets, and reports only their names', () => {
    expect(detectHostingPlatform({ NETLIFY: 'true', DEPLOY_PRIME_URL: 'https://x.netlify.app' })).toEqual({
      platform: 'netlify',
      evidence: ['NETLIFY', 'DEPLOY_PRIME_URL'],
    });
    expect(detectHostingPlatform({ VERCEL: '1', VERCEL_ENV: 'production' }).platform).toBe('vercel');
    expect(detectHostingPlatform({ CF_PAGES: '1' }).platform).toBe('cloudflare');
    expect(detectHostingPlatform({ AWS_APP_ID: 'd1abc' }).platform).toBe('aws');
    expect(detectHostingPlatform({ RENDER: 'true' }).platform).toBe('render');
    expect(detectHostingPlatform({ DYNO: 'web.1' }).platform).toBe('heroku');
    expect(detectHostingPlatform({ K_SERVICE: 'api' }).platform).toBe('google-cloud');
  });

  it('reports nothing for a developer machine or a platform it does not know', () => {
    expect(detectHostingPlatform({ HOME: '/Users/x', PATH: '/usr/bin' })).toEqual({ platform: null, evidence: [] });
    expect(detectHostingPlatform({ CI: 'true', GITHUB_ACTIONS: 'true' }).platform).toBeNull();
  });

  it('ignores a variable that is set but empty', () => {
    expect(detectHostingPlatform({ NETLIFY: '' }).platform).toBeNull();
  });
});
