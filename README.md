# @patchstack/connect

Connect a JavaScript / Node.js application to [Patchstack](https://patchstack.com) for continuous vulnerability monitoring. Scans your `package-lock.json` and reports installed packages so Patchstack can match them against its vulnerability database and notify you when something needs patching.

For how this repo fits with the wider Patchstack ecosystem (`saas`, `hub`, `patchstack-website`, `patchstack-connect`), see [`patchstack/saas` → `docs/ecosystem.md`](https://github.com/patchstack/saas/blob/main/docs/ecosystem.md).

## Agent-assisted setup

Copy this request into a coding assistant, or run the same command yourself:

> Run `npm i -D @patchstack/connect && npx --yes patchstack-connect setup`. It scans dependencies, adds its widget and build hooks, and prints the dashboard URL.

`setup` is state-aware and idempotent: it scans dependencies, provisions or reuses the site, manages the disclosure widget, wires the existing build command without replacing it, and prints the remaining setup status. It never runs the project build or the opt-in `protect` command. `guide` provides the same project-specific status without changing files.

## Quick start (zero configuration)

```bash
npm install --save-dev @patchstack/connect && npx @patchstack/connect setup
```

> **Use your project's own package manager.** On Bun-managed projects (including many Lovable projects) install with `bun add -d @patchstack/connect` instead — running `npm install` there plants a `package-lock.json` that the platform's native dependency flow never updates again, leaving a stale lockfile next to the live one. The connector detects and works around that (see *Stale lockfiles* below), but not creating the fossil is better.

That's it. `setup`:

1. Reads your lockfile (see *Supported lockfiles*).
2. POSTs the package list to Patchstack with **no** UUID.
3. Patchstack provisions a fresh site and returns its UUID.
4. The connector writes the UUID to `.patchstackrc.json` so the next `scan` targets the same site.
5. The connector installs the disclosure widget's `<script>` tag into your root HTML shell (see *The disclosure widget* below) so the "Report a vulnerability" button shows up on the next preview reload.
6. Wires `scan` before builds and `mark-build` after builds, preserving existing commands and using direct build chaining for Bun.
7. Prints a dashboard link — open it in a browser to attach the new site to your Patchstack account. You can re-display it any time with `npx @patchstack/connect status`.

## Quick start (existing site)

If you already created an "Application" site in the Patchstack dashboard, pre-seed the UUID:

```bash
npm install --save-dev @patchstack/connect
npx @patchstack/connect init <your-site-uuid>
npx @patchstack/connect setup
```

## CLI

```
patchstack-connect scan   [options]                Scan the lockfile and POST to Patchstack.
                                                   If no UUID is configured the server provisions
                                                   one and the connector persists it. After a
                                                   successful post, adds/updates the disclosure
                                                   widget tag in the root HTML shell (opt out
                                                   with "widget": false in .patchstackrc.json)
patchstack-connect setup  [options]                Run scan, manage the widget, and idempotently
                                                   wire package.json build scripts. Never runs
                                                   the project build or protect
patchstack-connect init   <site-uuid>              Optional: pre-seed .patchstackrc.json with
                                                   an existing site UUID
patchstack-connect status [options]                Show current configuration
patchstack-connect mark-build [options]            Stamp built HTML with a production flag +
                                                   build fingerprint and ensure the widget tag
                                                   in built pages (run as a postbuild step)
patchstack-connect guide                           Show this project's setup status (what's done,
                                                   what's missing, with tailored commands), then
                                                   print the full setup guide
patchstack-connect protect                         Opt-in: install the always-on runtime exploit
                                                   guard (currently TanStack Start + Supabase; it
                                                   patches the app's Supabase client to route
                                                   traffic through a same-origin guard). Never
                                                   run by scan/setup/guide/mark-build.
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
- `PATCHSTACK_ENDPOINT` — override the API endpoint (default `https://api.patchstack.com/monitor/pulse/manifest`)
- `PATCHSTACK_TIMEOUT_MS` — request timeout in milliseconds (default `30000`)

`.patchstackrc.json` example:

```json
{
  "siteUuid": "550e8400-e29b-41d4-a716-446655440000",
  "widget": true
}
```

`"widget"` is optional and defaults to `true`; set it to `false` to stop the connector from managing the disclosure-widget tag (see *The disclosure widget*).

The site UUID identifies the site; it is not a secret — the disclosure widget ships the same UUID in client-side HTML, and committing `.patchstackrc.json` is the intended workflow so every developer and CI run reports to the same site. Possession of the UUID lets someone submit dependency manifests for that site (noise, not data access). In CI setups where the file isn't committed, set `PATCHSTACK_SITE_UUID` instead.

## The disclosure widget

The widget is a floating "Report a vulnerability" button — a disclosure channel for anyone who spots a bug on the site. The connector manages its install so the UUID never has to be copied by hand:

- **`scan`** (after a successful post) adds this managed tag to the first root HTML shell it finds — `index.html`, `public/index.html`, or `src/app.html` — immediately before `</body>`:

  ```html
  <script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="<SITE_UUID>" defer data-patchstack-connect-widget="true"></script>
  ```

  Re-runs update the tag in place (the `data-patchstack-connect-widget` attribute marks it as connector-managed); a pre-existing manual widget tag is left untouched. `--dry-run` and failed posts never edit anything. Projects whose root layout is code rather than HTML (Next.js, Nuxt, Astro, …) get the exact snippet and target file printed instead — `guide` shows framework-specific placement.

- **`mark-build`** ensures the same tag in built HTML output, covering builds whose source shell the connector couldn't edit, and stamps `window.__PATCHSTACK_PROD__` so the widget hides the claim/login UI on the published site (owners reach it by appending `#patchstack` to the live URL).

- **Opting out:** persist `"widget": false` in `.patchstackrc.json` to disable both passes (dependency scanning only). Without it, the next successful scan re-adds the managed tag.

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

That's the entire payload. No source code, no environment variable values, no file paths — just the package names and versions from your lockfile. Duplicate names with different versions are preserved so transitive vulnerabilities aren't missed. (`mark-build` separately stamps built HTML with a stack descriptor that may include hosting-related env variable *names* — e.g. `VERCEL` — never their values.)

## Supported lockfiles

- ✅ `package-lock.json` (npm v6 / v2 / v3) — parsed directly
- ✅ `pnpm-lock.yaml` (pnpm v5 / v6 / v7 / v8 / v9) — parsed directly
- ✅ `yarn.lock` (yarn classic v1 and yarn berry v2+) — parsed directly
- ✅ `bun.lockb` (binary) — package list resolved by walking `node_modules/`
- ✅ `bun.lock` (text) — same fallback; direct parsing coming

If both a Bun lockfile and `node_modules/` are present, the connector walks `node_modules/` to enumerate the installed packages. Run `bun install` (or `npm install`) before scanning so the directory is populated.

### Stale lockfiles

Every scanned source is validated against `package.json`: if the chosen lockfile is missing dependencies that `package.json` declares, it is treated as a fossil (e.g. a `package-lock.json` created by a one-off `npm install` in a bun-managed project) and the connector falls through to the next source — ultimately walking `node_modules/`, the installed truth — and prints a warning naming the stale file. Delete the stale lockfile to silence the warning. Without this, the manifest and the build fingerprint would silently freeze while the real dependency set drifts.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

### Manifest endpoint testing

To post the current lockfile manifest to a local Patchstack API endpoint and provision a new site:

```bash
bun run test:manifest -- --endpoint http://localhost:8000/monitor/pulse/manifest
```

The response should include the new site UUID. To re-test an existing site, pass that UUID explicitly:

```bash
bun run test:manifest -- --endpoint http://localhost:8000/monitor/pulse/manifest --site-uuid YOUR_REAL_UUID
```

Use `--dry-run` to preview the payload without posting.

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
