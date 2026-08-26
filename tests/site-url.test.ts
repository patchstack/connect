import { describe, expect, it } from 'vitest';
import { detectSiteUrl, normaliseSiteUrl } from '../src/site-url.js';

describe('normaliseSiteUrl', () => {
  it('keeps a plain origin as it is', () => {
    expect(normaliseSiteUrl('https://app.example.com')).toBe('https://app.example.com');
  });

  it('fills in a scheme for the platforms that report a bare hostname', () => {
    expect(normaliseSiteUrl('app.example.com')).toBe('https://app.example.com');
  });

  it('reduces a reported page to the site origin', () => {
    expect(normaliseSiteUrl('https://app.example.com/dashboard?ref=build#top')).toBe(
      'https://app.example.com',
    );
  });

  it('keeps a non-default port, which is part of the address', () => {
    expect(normaliseSiteUrl('https://app.example.com:8443/')).toBe('https://app.example.com:8443');
  });

  it('refuses hosts that cannot be a published site', () => {
    // The address is what Patchstack fetches to check the live build. A build machine's own hostname
    // would send every later check to a host that is not the site.
    for (const host of [
      'http://localhost:3000',
      'http://127.0.0.1:5173',
      'https://my-mac.local',
      'http://10.0.0.4',
      'http://192.168.1.20:3000',
      'http://172.20.0.5',
      'http://0.0.0.0:8080',
    ]) {
      expect(normaliseSiteUrl(host)).toBeNull();
    }
  });

  it('refuses the placeholder host Patchstack uses for "no address known"', () => {
    expect(normaliseSiteUrl('https://pulse-abc123.placeholder.invalid')).toBeNull();
  });

  it('refuses anything that is not http(s), empty, or unparseable', () => {
    expect(normaliseSiteUrl('ftp://files.example.com')).toBeNull();
    expect(normaliseSiteUrl('   ')).toBeNull();
    expect(normaliseSiteUrl(undefined)).toBeNull();
    expect(normaliseSiteUrl(null)).toBeNull();
    expect(normaliseSiteUrl('https://')).toBeNull();
  });

  it('refuses an origin longer than the column that stores it', () => {
    expect(normaliseSiteUrl(`https://${'a'.repeat(200)}.example.com`)).toBeNull();
  });
});

describe('detectSiteUrl', () => {
  it('reads Vercel’s production domain on a production deployment', () => {
    expect(
      detectSiteUrl({
        VERCEL: '1',
        VERCEL_ENV: 'production',
        VERCEL_PROJECT_PRODUCTION_URL: 'shop.example.com',
        VERCEL_URL: 'shop-git-abc123-team.vercel.app',
      }),
    ).toEqual({ url: 'https://shop.example.com', platform: 'vercel' });
  });

  it('reports nothing for a Vercel preview build', () => {
    // The address is adopted once and then belongs to the site, so a per-deployment preview URL must
    // never become it.
    expect(
      detectSiteUrl({
        VERCEL: '1',
        VERCEL_ENV: 'preview',
        VERCEL_PROJECT_PRODUCTION_URL: 'shop.example.com',
        VERCEL_URL: 'shop-git-abc123-team.vercel.app',
      }),
    ).toBeNull();
  });

  it('reads Netlify’s site URL only in the production context', () => {
    const env = { NETLIFY: 'true', URL: 'https://site.example.com' };
    expect(detectSiteUrl({ ...env, CONTEXT: 'production' })).toEqual({
      url: 'https://site.example.com',
      platform: 'netlify',
    });
    expect(detectSiteUrl({ ...env, CONTEXT: 'deploy-preview' })).toBeNull();
  });

  it('ignores a bare URL variable with no Netlify marker beside it', () => {
    // `URL` is generic enough to belong to any tool in the build.
    expect(detectSiteUrl({ URL: 'https://something-else.example.com' })).toBeNull();
  });

  it('reads Render’s external URL, except on a pull-request preview', () => {
    const env = { RENDER: 'true', RENDER_EXTERNAL_URL: 'https://api.example.com' };
    expect(detectSiteUrl(env)).toEqual({ url: 'https://api.example.com', platform: 'render' });
    expect(detectSiteUrl({ ...env, IS_PULL_REQUEST: 'true' })).toBeNull();
  });

  it('reads Railway’s public domain in the production environment only', () => {
    const env = { RAILWAY_PUBLIC_DOMAIN: 'app.up.railway.app' };
    expect(detectSiteUrl({ ...env, RAILWAY_ENVIRONMENT_NAME: 'production' })).toEqual({
      url: 'https://app.up.railway.app',
      platform: 'railway',
    });
    expect(detectSiteUrl({ ...env, RAILWAY_ENVIRONMENT_NAME: 'staging' })).toBeNull();
  });

  it('reports nothing for a laptop build', () => {
    expect(detectSiteUrl({})).toBeNull();
  });

  it('reports nothing on Cloudflare Pages, which cannot say which deployment is production', () => {
    expect(
      detectSiteUrl({ CF_PAGES: '1', CF_PAGES_URL: 'https://abc123.project.pages.dev' }),
    ).toBeNull();
  });
});
