# @patchstack/connect

Connect a JavaScript / Node.js application to [Patchstack](https://patchstack.com) for continuous vulnerability monitoring. Scans your `package-lock.json` and reports installed packages so Patchstack can match them against its vulnerability database and notify you when something needs patching.

## Install prompt (for AI coding tools)

Copy and paste this prompt into any AI coding assistant (Cursor, v0, Bolt, Lovable, Claude Code, etc.):

> Add `@patchstack/connect` to this project as a dev dependency, then add `"prebuild": "patchstack-connect scan"` to `package.json` `scripts`. The first time the script runs, Patchstack provisions a site automatically from the lockfile and saves the new site UUID to `.patchstackrc.json` — no dashboard signup or manual UUID required. Commit `.patchstackrc.json` so every developer / CI run targets the same site.

## Quick start (zero configuration)

```bash
npm install --save-dev @patchstack/connect
npx @patchstack/connect scan
```

That's it. The first `scan`:

1. Reads your `package-lock.json`.
2. POSTs the package list to Patchstack with **no** UUID.
3. Patchstack provisions a fresh site and returns its UUID.
4. The connector writes the UUID to `.patchstackrc.json` so the next `scan` targets the same site.

Then wire it into builds:

```jsonc
// package.json
{
  "scripts": {
    "prebuild": "patchstack-connect scan"
  }
}
```

## Quick start (existing site)

If you already created an "Application" site in the Patchstack dashboard, pre-seed the UUID:

```bash
npm install --save-dev @patchstack/connect
npx @patchstack/connect init <your-site-uuid>
npx @patchstack/connect scan
```

## CLI

```
patchstack-connect scan   [options]                Scan the lockfile and POST to Patchstack.
                                                   If no UUID is configured the server provisions
                                                   one and the connector persists it.
patchstack-connect init   <site-uuid>              Optional: pre-seed .patchstackrc.json with
                                                   an existing site UUID
patchstack-connect status [options]                Show current configuration
patchstack-connect help                            Print help

Options (for scan and status):
  --site-uuid <uuid>      Override the configured site UUID
  --endpoint <url>        Override the API endpoint
  --dry-run               (scan only) Print the payload without posting
```

## Configuration

Precedence (highest wins):

1. CLI flag (`--site-uuid`, `--endpoint`)
2. Environment variable
3. `.patchstackrc.json` in the current directory

Environment variables:

- `PATCHSTACK_SITE_UUID` — the site UUID from your Patchstack dashboard
- `PATCHSTACK_ENDPOINT` — override the API endpoint (default `http://api.patchstack.com/monitor/pulse/manifest`)
- `PATCHSTACK_TIMEOUT_MS` — request timeout in milliseconds (default `30000`)

`.patchstackrc.json` example:

```json
{
  "siteUuid": "550e8400-e29b-41d4-a716-446655440000"
}
```

The site UUID is the only credential. Possession of it grants the right to submit manifests for that site, so treat it like an API token: keep it out of public repos, and prefer the environment variable in CI.

## Programmatic API

```ts
import { scanAndReport } from '@patchstack/connect';

const result = await scanAndReport();
console.log(result.response.stored ? 'Reported' : 'Unchanged');
```

Lower-level pieces are also exported: `scanLockfile`, `buildWirePayload`, `postManifest`, `resolveConfig`.

## What gets sent

```json
{
  "ecosystem": "npm",
  "packages": [
    { "name": "axios",  "version": "1.6.0" },
    { "name": "lodash", "version": "4.17.15" },
    { "name": "lodash", "version": "4.17.21" }
  ]
}
```

That's the entire payload. No source code, no environment variables, no file paths — just the package names and versions from your lockfile. Duplicate names with different versions are preserved so transitive vulnerabilities aren't missed.

## Supported lockfiles

- ✅ `package-lock.json` (npm v6 / v2 / v3) — parsed directly
- ✅ `bun.lockb` (binary) — package list resolved by walking `node_modules/`
- ✅ `bun.lock` (text) — same fallback; direct parsing coming
- ❌ `yarn.lock` — coming soon
- ❌ `pnpm-lock.yaml` — coming soon

If both a Bun lockfile and `node_modules/` are present, the connector walks `node_modules/` to enumerate the installed packages. Run `bun install` (or `npm install`) before scanning so the directory is populated.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Release process

Pull requests run typecheck, tests, build, package verification, and a production dependency audit in GitHub Actions.

Publishing runs when a GitHub Release is published. The release tag must match the package version in `package.json` with a leading `v`. For example, `package.json` version `0.2.0` must be released with tag `v0.2.0`; otherwise the workflow fails before publishing.

To publish a release:

1. Bump the package version, for example `npm version 0.2.0 --no-git-tag-version`.
2. Commit `package.json` and `package-lock.json`.
3. Merge the version bump to `main`.
4. Create and publish a GitHub Release tagged `v0.2.0`.
5. The `Publish` workflow verifies the package, then runs `npm publish --provenance --access public`.

Before the first release, configure npm trusted publishing for this package:

1. Merge `.github/workflows/publish.yml` to `main`.
2. Open the `@patchstack/connect` package settings on npmjs.com.
3. In **Trusted publishing**, choose **GitHub Actions**.
4. Configure:
   - Organization/user: `patchstack`
   - Repository: `connect`
   - Workflow filename: `publish.yml`
   - Environment name: `npm`
5. In GitHub repository settings, create an `npm` environment. Optional but recommended: require reviewer approval for that environment.

Do not add an npm publish token to GitHub secrets for this workflow. Trusted publishing uses GitHub OIDC short-lived credentials. After the first trusted publish succeeds, npm recommends setting package publishing access to require two-factor authentication and disallow tokens.

## License

MIT
