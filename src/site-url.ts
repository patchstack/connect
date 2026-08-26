/**
 * Where the app this manifest describes is published.
 *
 * Patchstack provisions a site from the first manifest, and a manifest posted from a laptop carries no
 * address — so those sites are created with a synthetic `*.placeholder.invalid` host. That address is not
 * cosmetic: it is what Patchstack fetches to check the live build still carries what was scanned, and what
 * the dashboard shows. Something has to replace it, and the manifest push is the only thing that reports
 * from inside the deployment while holding the site's own credential.
 *
 * Reporting a wrong address is worse than reporting none, because the address is adopted once and then
 * belongs to the site. So a URL is only derived from a build environment that says, in its own variables,
 * that this build is the production one — never from a per-deployment preview URL, and never from a host
 * that could not be a published site (a laptop, a private network). A platform that publishes no such
 * signal is left alone: set `url` in `.patchstackrc.json` (or `PATCHSTACK_SITE_URL`) and that wins over
 * everything here.
 *
 * Unlike the hosting fingerprint in `stack.ts`, which reports variable NAMES only, this reads values. It
 * reads exactly the ones below, each of which is a public address the deployed site serves to every
 * visitor.
 */

/** Hosts that cannot be a published site, whatever a build environment claims. */
function isUnpublishableHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  return (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    // The value Patchstack itself uses for "no address known" — storing it as one would be circular.
    host.endsWith('.placeholder.invalid') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Reduce a reported address to the `scheme://host[:port]` Patchstack stores, or null when it is not one.
 *
 * Several platforms report a bare hostname, so a missing scheme is filled in rather than rejected. A path
 * is dropped: the site's address is its origin, and a build variable that happens to include one is still
 * naming the same site.
 */
export function normaliseSiteUrl(value: string | undefined | null): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname === '' || isUnpublishableHost(parsed.hostname)) return null;

  const origin = `${parsed.protocol}//${parsed.host}`;

  // Patchstack stores the address in a 191-character column; an origin near that length is not one.
  return origin.length <= 191 ? origin : null;
}

/**
 * The platforms that publish a production address AND a way to know the current build is the production
 * one. Both halves are required: a deploy URL without that signal names a preview, and a preview URL
 * adopted as the site's address sends every later check to the wrong place.
 */
const PRODUCTION_URL_SOURCES: ReadonlyArray<{
  platform: string;
  read: (env: NodeJS.ProcessEnv) => string | undefined;
}> = [
  {
    // VERCEL_URL is per-deployment and changes every build, so it is deliberately not read here.
    platform: 'vercel',
    read: (env) => (env.VERCEL_ENV === 'production' ? env.VERCEL_PROJECT_PRODUCTION_URL : undefined),
  },
  {
    // `URL` is generic enough to belong to anything, so it counts only alongside Netlify's own markers.
    platform: 'netlify',
    read: (env) => (env.NETLIFY === 'true' && env.CONTEXT === 'production' ? env.URL : undefined),
  },
  {
    platform: 'render',
    read: (env) =>
      env.RENDER === 'true' && env.IS_PULL_REQUEST !== 'true' ? env.RENDER_EXTERNAL_URL : undefined,
  },
  {
    platform: 'railway',
    read: (env) =>
      env.RAILWAY_ENVIRONMENT_NAME === 'production' ? env.RAILWAY_PUBLIC_DOMAIN : undefined,
  },
];

export interface DetectedSiteUrl {
  /** The `scheme://host[:port]` to report. */
  url: string;
  /** Which build environment it came from, for the CLI to say so out loud. */
  platform: string;
}

/**
 * The production address this build environment reports, or null when it reports none.
 *
 * Cloudflare Pages is a deliberate omission: `CF_PAGES_URL` is the deployment's own URL and the build
 * environment gives no way to tell a production deployment from a branch one, so there is nothing here
 * that could be adopted safely. Those projects set `url` explicitly.
 */
export function detectSiteUrl(env: NodeJS.ProcessEnv = process.env): DetectedSiteUrl | null {
  for (const source of PRODUCTION_URL_SOURCES) {
    const url = normaliseSiteUrl(source.read(env));
    if (url !== null) {
      return { url, platform: source.platform };
    }
  }

  return null;
}
