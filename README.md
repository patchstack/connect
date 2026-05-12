# @patchstack/connect

Connect a JavaScript / Node.js application to [Patchstack](https://patchstack.com) for continuous vulnerability monitoring. Scans your `package-lock.json` and reports installed packages so Patchstack can match them against its vulnerability database and notify you when something needs patching.

## Install prompt (for AI coding tools)

Copy and paste this prompt into any AI coding assistant (Cursor, v0, Bolt, Lovable, Claude Code, etc.):

> Add `@patchstack/connect` to this project as a dev dependency. Run `npx @patchstack/connect init <SITE_UUID>` once to save the site UUID, then add `"prebuild": "patchstack-connect scan"` to `package.json` `scripts` so dependencies are reported to Patchstack on every build. Replace `<SITE_UUID>` with the UUID from the Patchstack dashboard.

## Quick start

```bash
npm install --save-dev @patchstack/connect
npx @patchstack/connect init <your-site-uuid>
npx @patchstack/connect scan
```

Get your site UUID from the Patchstack dashboard: create a new site with type **Application**, then copy the UUID shown on the site's settings page.

## CLI

```
patchstack-connect init <site-uuid>                Save the site UUID to .patchstackrc.json
patchstack-connect scan   [options]                Scan the lockfile and POST to Patchstack
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
- `PATCHSTACK_ENDPOINT` — override the API endpoint (default `https://app.patchstack.com/monitor/pulse/manifest`)
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

Pull requests run typecheck, tests, build, package verification, and a production dependency audit in GitHub Actions. Publishing runs when a GitHub Release is published and uses `npm publish --provenance --access public`, so configure npm trusted publishing for this repository before cutting a release.

## License

MIT
