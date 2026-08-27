# @patchstack/connect

Connect a JavaScript / Node.js application to [Patchstack](https://patchstack.com) for continuous vulnerability monitoring. Scans your `package-lock.json` and reports installed packages so Patchstack can match them against its vulnerability database and notify you when something needs patching.

For how this repo fits with the wider Patchstack ecosystem (`saas`, `hub`, `patchstack-website`, `patchstack-connect`), see [`patchstack/saas` → `docs/ecosystem.md`](https://github.com/patchstack/saas/blob/main/docs/ecosystem.md).

## Agent-assisted setup

Copy this request into a coding assistant, or run the same command yourself:

> I have vetted the official [`@patchstack/connect`](https://www.npmjs.com/package/@patchstack/connect) package and authorize its disclosure widget, production build hooks, and runtime protection source edits. Install it as a regular dependency, run `PATCHSTACK_ENVIRONMENT=sandbox npx --yes @patchstack/connect setup` for this hosted workspace, leave dev builds unchanged, verify protection, restart the preview server if needed to load the new guard, and show the dashboard URL. Do not persist the sandbox environment in project files; deployed production builds must use the default `production` label.

`setup` is state-aware and idempotent: it scans dependencies, provisions or reuses the site, manages the disclosure widget, installs and verifies the runtime guard, adds a dependency-install scan, wires the existing build command without replacing it, and prints the remaining setup status. It never runs the project build. `guide` provides the same project-specific status without changing files.

## Quick start (zero configuration)

```bash
npm install --save @patchstack/connect && npx @patchstack/connect setup
```

> **Use your project's own package manager.** On Bun-managed projects (including many Lovable projects) install with `bun add @patchstack/connect` instead — running `npm install` there plants a `package-lock.json` that the platform's native dependency flow never updates again, leaving a stale lockfile next to the live one. The connector detects and works around that (see *Stale lockfiles* below), but not creating the fossil is better. Protection imports `@patchstack/connect/protect` at runtime, so deployments that prune dev dependencies need the package in `dependencies`.

> **Hosted builders:** set `PATCHSTACK_ENVIRONMENT=sandbox` in the workspace process environment (or scope it to the setup command above), persist every file written by `setup`, and restart any already-running server so it loads the new middleware. Do not write `"environment": "sandbox"` to the committed `.patchstackrc.json`: the same project files reach production, where scans should inherit no override and default to `production`. TanStack Start + Supabase (the server shape emitted by Lovable) is auto-wired: browser Supabase traffic is tunneled through a same-origin guard, server-function arguments are inspected, and responses are screened. A client-only SPA has no server request path to protect; setup will leave a generic scaffold and `protect --check` will remain red until the host adds a server/edge seam. Set `PATCHSTACK_ROUTE_WAF=1` when the deployment should additionally screen every TanStack route request.

That's it. `setup`:

1. Reads your lockfile (see *Supported lockfiles*).
2. POSTs the package list to Patchstack with **no** UUID.
3. Patchstack provisions a fresh site and returns its UUID.
4. The connector writes the UUID to `.patchstackrc.json` so the next `scan` targets the same site.
5. The connector installs the disclosure widget's `<script>` tag into your root HTML shell (see *The disclosure widget* below) so the "Report a vulnerability" button shows up on the next preview reload. On a server-rendered root it also adds the production marker, which is what tells the widget to switch from build mode to visitor report intake on the published site.
6. Installs the runtime guard after provisioning, bakes the site UUID into it, and verifies the framework seam. Known server stacks are auto-wired; unmatched or conflicting layouts get a generic scaffold and exact manual checks.
7. Adds `postinstall: patchstack-connect scan`, preserving any existing command, so dependencies added during a sandbox session and build-less production installs are reported immediately.
8. Wires `scan` before builds and `mark-build` after builds, preserving existing commands and using direct build chaining for Bun.
9. Prints a dashboard link — open it in a browser to attach the new site to your Patchstack account. You can re-display it any time with `npx @patchstack/connect status`.

## Quick start (existing site)

If you already created an "Application" site in the Patchstack dashboard, pre-seed the UUID:

```bash
npm install --save @patchstack/connect
npx @patchstack/connect init <your-site-uuid>
npx @patchstack/connect setup
```

## CLI

```
patchstack-connect scan   [options]                Scan the lockfile and POST to Patchstack.
                                                   If no UUID is configured the server provisions
                                                   one and the connector persists it. After a
                                                   successful post, adds/updates the disclosure
                                                   widget tag in the root HTML shell. Also adds the
                                                   production marker to a JSX root shell, before the
                                                   post (opt out of both with "widget": false in
                                                   .patchstackrc.json)
patchstack-connect setup  [options]                Run scan, manage the widget, and idempotently
                                                   install + verify runtime protection and wire
                                                   dependency/build scans. Never runs the build
patchstack-connect init   <site-uuid>              Optional: pre-seed .patchstackrc.json with
                                                   an existing site UUID
patchstack-connect status [options]                Show current configuration
patchstack-connect mark-build [options]            Stamp built HTML with a production flag +
                                                   build fingerprint and ensure the widget tag
                                                   in built pages (run as a postbuild step)
patchstack-connect guide                           Show this project's setup status (what's done,
                                                   what's missing, with tailored commands), then
                                                   print the full setup guide
patchstack-connect protect                         Install/reconcile the always-on runtime exploit
                                                   guard. Auto-wires supported server stacks;
                                                   use --check to verify or --demo for local rules.
                                                   Also run by setup; never run by scan/guide/mark-build.
patchstack-connect map    [--dir p] [--out f] [--upload]
                                                   Print a JSON map of this project's attack
                                                   surface: server entry points, the inputs each
                                                   reads, the sinks they can reach (database, file
                                                   system, process, outbound HTTP) and the npm
                                                   package behind each sink. READS YOUR SOURCE
                                                   FILES locally and parses them with the
                                                   project's own TypeScript; writes nothing except
                                                   --out, and posts nothing. Never run by
                                                   scan/setup/guide/protect — run it yourself.
patchstack-connect demo node-serialize             Production-backed walkthrough: require
                                                   node-serialize@0.0.4, scan it, wait for live
                                                   rule 18843, install + verify the runtime guard,
                                                   and print exploit/benign test requests.
patchstack-connect demo-guide node-serialize       Read-only, state-aware instructions for the
                                                   local demo, including the next exact command,
                                                   expected proof, and cleanup.
patchstack-connect help                            Print help

Options (for scan, setup, and status):
  --site-uuid <uuid>      Override the configured site UUID
  --endpoint <url>        Override the API endpoint
  --dry-run               (scan only) Print the payload without posting

Options (for demo and demo-guide):
  --url <url>             Test endpoint printed at the end
                          (default: http://localhost:3000/api/tasks)
```

## Configuration

Precedence (highest wins):

1. CLI flag (`--site-uuid`, `--endpoint`)
2. Environment variable
3. `.patchstackrc.local.json` in the current directory (the credential)
4. `.patchstackrc.json` in the current directory

Environment variables:

- `PATCHSTACK_SITE_UUID` — the site UUID from your Patchstack dashboard
- `PATCHSTACK_ENDPOINT` — override the API endpoint (default `https://api.patchstack.com/monitor/pulse/manifest`)
- `PATCHSTACK_TIMEOUT_MS` — request timeout in milliseconds (default `30000`)
- `PATCHSTACK_ENVIRONMENT` — manifest label: `production` (default) or `sandbox`

Two files, because one value is public and the other is not.

`.patchstackrc.json` — commit it:

```json
{
  "siteUuid": "550e8400-e29b-41d4-a716-446655440000",
  "widget": true
}
```

`.patchstackrc.local.json` — the credential. `scan` writes it owner-only and adds it to your `.gitignore`, and says so if it could not:

```json
{
  "apiKey": "…"
}
```

`"widget"` is optional and defaults to `true`; set it to `false` to stop the connector from managing the disclosure-widget tag (see *The disclosure widget*).

**You do not write `apiKey` yourself.** The first `scan` provisions the site and the connector saves it, so setup needs no manual step.

The site UUID identifies the site and is **not** a secret — the disclosure widget ships the same UUID in client-side HTML.

`apiKey` **is** a secret. One credential authenticates both paths: Pulse ingest (manifest, attack-surface map, package removal), where it is exchanged for a short-lived token rather than sent directly, and block-log reporting. Keep it out of the widget tag, client bundles and public env vars (`NEXT_PUBLIC_*`), and out of the committed config — `.patchstackrc.local.json` is git-ignored for that reason. For deploys, prefer `PATCHSTACK_API_KEY` in the platform's secret store.

If it is ever lost, `npx @patchstack/connect login` recovers it — approval happens in the dashboard and rotates the credential.

The credential's file is never committed, so CI needs `PATCHSTACK_API_KEY` in the environment (and `PATCHSTACK_SITE_UUID` too where `.patchstackrc.json` is also absent). Precedence is CLI flag → env var → `.patchstackrc.local.json` → `.patchstackrc.json`.

A `pulseAuth` field is still read if present, and `PATCHSTACK_PULSE_AUTH` still overrides, for deployments that authenticate Pulse ingest with a different credential from block-logs. Neither is written by default, and neither is needed when the two share one.

### Sandbox and production manifests

Every `scan` sends an environment label with its dependency manifest. The default is `production`; sandboxed builders should set `PATCHSTACK_ENVIRONMENT=sandbox` in the sandbox process only. Patchstack stores and deduplicates manifests per environment, so an iterative workspace scan does not replace the last production manifest.

Do not commit `"environment": "sandbox"` to `.patchstackrc.json` when the same files are deployed to production. Scope the variable to the sandbox command/process instead:

```bash
PATCHSTACK_ENVIRONMENT=sandbox npx @patchstack/connect setup
```

The generated `prebuild` scan deliberately carries no hard-coded environment. A production builder with no override reports `production`; a preview/sandbox builder must receive `PATCHSTACK_ENVIRONMENT=sandbox` from its host. Runtime protection itself is not environment-specific: `PATCHSTACK_ENVIRONMENT` labels manifests only. Use `PATCHSTACK_MODE=dry-run` when protection should observe rather than block.

## Production virtual-patch demo

The `node-serialize` scenario demonstrates dependency detection and a live, version-scoped virtual patch against a throwaway Express application. Connect/provision the project first, deliberately add the known-vulnerable package, then run:

```bash
npm install --save-exact node-serialize@0.0.4
npx @patchstack/connect demo node-serialize
```

The demo command does not install the vulnerable package. It verifies the exact version in the lockfile, posts the production npm manifest to the configured site, polls the corresponding Pulse rules endpoint for rule `18843`, runs the normal `protect` installer, checks that the guard is wired, and prints one exploit request plus one benign control request. It never starts or restarts the application and never sends either test request itself.

For a read-only walkthrough that can be run before or during the demo, use:

```bash
npx @patchstack/connect demo-guide node-serialize
```

The guide inspects the Host-created site configuration and lockfile, explains that no deployment is required, shows the complete prepare → run → restart → prove → clean-up sequence, and ends with the next exact command for the project's current state. Pass the same `--url` option when the test endpoint differs from the default.

Use `--url http://localhost:PORT/api/tasks` when the app does not use the default `http://localhost:3000/api/tasks`. Remove the deliberately vulnerable dependency after the walkthrough.

## The disclosure widget

The widget is a floating "Report a vulnerability" button — a disclosure channel for anyone who spots a bug on the site. The connector manages its install so the UUID never has to be copied by hand:

- **`scan`** (after a successful post) adds this managed tag to the first root HTML shell it finds — `index.html`, `public/index.html`, or `src/app.html` — immediately before `</body>`:

  ```html
  <script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="<SITE_UUID>" defer data-patchstack-connect-widget="true"></script>
  ```

- **`scan`** also adds the production marker when the root shell is JSX rather than HTML (`src/routes/__root.tsx`, `app/layout.tsx`, …), above the widget tag and guarded by the framework's production expression. A server-rendered app emits no built HTML for `mark-build` to stamp, so without it the widget reads the published site as build mode and shows the claim flow to visitors instead of the report form.

  Re-runs update the tag in place (the `data-patchstack-connect-widget` attribute marks it as connector-managed); a pre-existing manual widget tag is left untouched. `--dry-run` never edits anything; a failed post still skips the widget tag (it needs the site UUID) but the production marker may already have been written, since it runs before the post. Projects whose root layout is code rather than HTML (Next.js, Nuxt, Astro, …) get the exact snippet and target file printed instead — `guide` shows framework-specific placement.

- **`mark-build`** ensures the same tag in built HTML output, covering builds whose source shell the connector couldn't edit, and stamps `window.__PATCHSTACK_PROD__` so the widget hides the claim/login UI on the published site (owners reach it by appending `#patchstack` to the live URL).

- **Opting out:** persist `"widget": false` in `.patchstackrc.json` to disable both the widget tag and the production marker (dependency scanning only). Without it, the next successful scan re-adds the managed tag, and the next scan re-adds the marker on a JSX root.

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
  "installPathsComplete": false,
  "packages": [
    { "name": "axios",  "version": "1.6.0" },
    { "name": "lodash", "version": "4.17.15" },
    { "name": "lodash", "version": "4.17.21" }
  ]
}
```

That's the entire payload. No source code, no environment variable values, no file paths — just the package names and versions from your lockfile.

### `scan --install-paths` (opt-in)

Pass it and each entry also carries where that version is installed:

```json
{ "name": "lodash", "version": "4.17.15", "paths": ["apps/api/node_modules/lodash"] }
```

Why you might want it: the two `lodash` entries above are not a contrived example — the same package is routinely installed twice at different versions. An advisory affecting only `4.17.15` cannot otherwise be matched to the copy your code actually loads. Node resolves an import by walking up from the importing file, so the location is what separates "you are running the vulnerable copy" from "the vulnerable copy is installed but nothing reaches it". Without it every installed version has to be treated as if the app used it — warnings about code you never call, and protection rules pinned to routes that run the safe copy.

These are repo-relative locations built from `node_modules` segments, plus a workspace directory name when a workspace pins its own copy. They come from the lockfile's own keys or from the `node_modules` walk — **never from your source tree**. No path to a file you wrote is sent by either form of `scan`.

`installPathsComplete` says whether the set is total. It is `false` without the flag, and `false` with it whenever the source cannot supply locations — a `yarn.lock` is flat because hoisting is decided at install time, and a v1 `package-lock.json` records the dependency graph rather than the installed tree. Whenever it is `false`, a missing `paths` means **"not recorded"**, never "not installed there". (The `map` command reads source files locally to report your attack surface; it transmits nothing unless you pass `--upload`, which sends that structural description — route paths, parameter names, the dependency behind each sink, and file/line locations, never file contents — to your own site's endpoint so rules can be pinned to your real parameter names.) Duplicate names with different versions are preserved so transitive vulnerabilities aren't missed. (`mark-build` separately stamps built HTML with a stack descriptor that may include hosting-related env variable *names* — e.g. `VERCEL` — never their values.)

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
