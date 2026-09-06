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
 * that is not how the public reaches a website. A platform that publishes no such signal is left alone:
 * set `url` in `.patchstackrc.json` (or `PATCHSTACK_SITE_URL`) and that wins over everything here.
 *
 * Unlike the hosting fingerprint in `stack.ts`, which reports variable NAMES only, this reads values. It
 * reads exactly the ones below, each of which is a public address the deployed site serves to every
 * visitor.
 */

/**
 * Suffixes reserved for names that are deliberately not reachable from the public internet: the
 * special-use domains (RFC 2606, RFC 6761), mDNS, the reverse-lookup zones, and the private zones cloud
 * networks hand out. `.invalid` also covers the `*.placeholder.invalid` value Patchstack itself stores
 * for "no address known" — reporting that back as an address would be circular.
 */
const RESERVED_SUFFIXES: readonly string[] = [
  '.local',
  '.localhost',
  '.localdomain',
  '.internal',
  '.intranet',
  '.invalid',
  '.test',
  '.example',
  '.home.arpa',
  '.in-addr.arpa',
  '.ip6.arpa',
];

/**
 * Hosts that cannot be a published site, whatever a build environment claims.
 *
 * The reported address is not only stored: it is what Patchstack fetches to check the published page. A
 * host that resolves inside a network is therefore worse than a wrong answer — it aims a later fetch at
 * something that was never the site. So the shape of a public website's address is what is accepted here,
 * rather than a list of the private ranges to exclude: such a list has to be kept current, and is in any
 * case only the ranges somebody thought of.
 */
function isUnpublishableHost(hostname: string): boolean {
  // `URL` keeps a trailing root dot, and `localhost.` resolves exactly as `localhost` does.
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host === '') return true;

  // No IP literal, in either family. A hosting platform names its production site with a hostname, so a
  // literal arriving here is a build machine or an address on a network rather than a site — and deciding
  // which would mean carrying every reserved range of both families. `URL` has already reduced the
  // alternative spellings to the canonical one (`0x7f.1` and `2130706433` both arrive as `127.0.0.1`,
  // `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`), so these two tests match every way of writing them.
  if (host.startsWith('[')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;

  // A single-label host is a name on someone's own network — `production`, `web`, a build container's
  // hostname. A site the public can reach sits under a registered domain.
  if (!host.includes('.')) return true;

  return RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix));
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

  // 191 characters is the most Patchstack accepts for an address; an origin near that length is not one.
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
  /** Which build environment it came from, so the CLI can print it. */
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
