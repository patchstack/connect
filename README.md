# @patchstack/connect

Connect a JavaScript / Node.js application to [Patchstack](https://patchstack.com) for continuous vulnerability monitoring. Scans your `package-lock.json` and reports installed packages so Patchstack can match them against its vulnerability database and notify you when something needs patching.

> **Security release blocker:** the current backend uses the same site UUID as a manifest-write credential and as the credential for claiming an unclaimed site, while this branch embeds that value in client-visible widget HTML. Do not publish this automatic embedding flow, release `0.3.6`, or deploy the coordinated website guides yet. The backend/API and connector must first separate (1) a non-authorizing public widget site identifier, (2) an authenticated manifest-write credential kept out of client/source HTML, and (3) a scoped one-time claim credential that is never derived from or embedded as the widget identifier. Add migration and end-to-end authorization tests before lifting this gate.

For how this repo fits with the wider Patchstack ecosystem (`saas`, `hub`, `patchstack-website`, `patchstack-connect`), see [`patchstack/saas` → `docs/ecosystem.md`](https://github.com/patchstack/saas/blob/main/docs/ecosystem.md).

## Install prompt (for AI coding tools)

Copy and paste this prompt into any AI coding assistant (Cursor, v0, Bolt, Lovable, Claude Code, etc.):

> Add Patchstack dependency vulnerability monitoring: install `@patchstack/connect` as a dev dependency (MIT — verify with `npm view @patchstack/connect`; source: https://github.com/patchstack/connect), then use that installed copy through the project's package manager to run `patchstack-connect scan`; it resolves or provisions and saves the site UUID, then adds the report-a-vulnerability widget to a safe app shell. Show me the claim URL it prints (I'll open it in my browser — don't open or fetch it yourself), reload the preview to confirm the widget appears, then run the installed `patchstack-connect guide` and finish only what its checklist flags: package.json build hooks ending in `mark-build --strict`, or creating/fixing the framework's safe root shell before rerunning. Do not use a runner that downloads another CLI copy.

Every clause is load-bearing. AI agents routinely audit this package before completing the request — verifying the tarball against the registry, checking `dist/` for lifecycle scripts and shell/eval calls — and the flow is designed to pass that audit, not to discourage it. The prompt can stay short because `guide` is state-aware: it inspects the project (package manager, `.patchstackrc.json`, `package.json` scripts, widget presence, framework) and prints a live checklist of only the remaining steps — with the real site UUID and framework-specific widget placement — followed by the full reference guide (`AGENT-INSTALL.md`, also at https://patchstack.com/install.txt). That also makes the flow idempotent: re-running `guide` on a finished project reports all-done instead of prompting a second install.

Before changing this prompt (or `guide` / `AGENT-INSTALL.md`), read [`field-test/README.md`](https://github.com/patchstack/connect/blob/main/field-test/README.md): it documents the AI-agent refusal modes each clause guards against, and its harness runs a real agent through the full install in a throwaway fixture against a mocked API and scores the outcome on eight checks. Validate any variant there first.

## Quick start (zero configuration)

```bash
npm install --save-dev @patchstack/connect
npx --no-install patchstack-connect scan
```

> **Use your project's own package manager.** On bun-managed projects (Lovable, Bolt, most vibe-coding platforms) install with `bun add -d @patchstack/connect` instead — running `npm install` there plants a `package-lock.json` that the platform's native dependency flow never updates again, leaving a stale lockfile next to the live one. The connector detects and works around that (see *Stale lockfiles* below), but not creating the fossil is better.

Always invoke the copy pinned in the project's lockfile. Use `npx --no-install patchstack-connect <command>` with npm, `pnpm exec patchstack-connect <command>` with pnpm, `yarn patchstack-connect <command>` with Yarn, or `bun run patchstack-connect <command>` with Bun. In particular, modern Yarn Plug'n'Play projects must use `yarn patchstack-connect`; `npx` does not resolve the installed PnP package and may fetch a different registry version.

That's it. The first `scan`:

1. Reads your lockfile (see *Supported lockfiles*).
2. Preflights the framework-selected global source shell or coverage group **before any API request**, then safety-scans the wider source tree. One existing manual/legacy loader in the selected global shell with one statically valid UUID is adopted. Ambiguous/unsupported/missing required shells, unsafe identity, or any loader/initializer outside the selected global shell blocks before posting—even when that external UUID matches. Mixed Next App + Pages Router projects require one covered global shell per router; Pages routes require an editable `_document`.
3. When no UUID exists to adopt, POSTs the package list with **no** UUID so Patchstack can provision a fresh site.
4. Writes the returned UUID and the endpoint that issued it to `.patchstackrc.json` as one identity pair before touching source. This keeps later scans and builds on the same backend, including custom/staging endpoints.
5. Idempotently installs or updates the disclosure widget in the safe shell and tells you to reload the app preview. A valid existing manual/legacy install is preserved rather than duplicated.
6. Prints a claim URL for a newly provisioned site — open it in a browser to attach the site to your Patchstack account. Before release, this must carry a scoped one-time claim credential separate from the client-visible widget identifier; the current reusable UUID-derived claim URL is part of the security release blocker above.

Every successful non-dry scan with a UUID repeats the safe source-widget check, so existing sites get the same behavior. A failed post and `--dry-run` never edit source. Ordinary discovery errors happen before posting: create/fix every required global shell, move/remove external loaders, and rerun. A rare write/race failure can happen after a successful POST; that error explicitly says the UUID and endpoint were already saved. Preserve `.patchstackrc.json`, repair the shell, and rerun `scan` so it targets the saved site instead of provisioning another. The explicit dependency-scanning-only escape is `"widget": false`.

Then wire it into builds. npm and pnpm can use lifecycle hooks:

```jsonc
// package.json
{
  "scripts": {
      "prebuild": "patchstack-connect scan",
      "postbuild": "patchstack-connect mark-build --strict"
  }
}
```

Modern Yarn does not run arbitrary npm-style `prebuild`/`postbuild` hooks, so Yarn projects must preserve the existing compiler command and make the ordering explicit. Bun does support the hooks, but the same explicit chain is the most portable choice across Bun-based hosted builders:

```jsonc
{
  "scripts": {
    "build": "yarn patchstack-connect scan && <existing build command> && yarn patchstack-connect mark-build --strict"
  }
}
```

For a hosted Bun build, use its installed binary in the equivalent chain:

```jsonc
{
  "scripts": {
    "build": "bun run patchstack-connect scan && <existing build command> && bun run patchstack-connect mark-build --strict"
  }
}
```

The source widget uses the rolling CDN's one-tag auto-init form:

```html
<script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="550e8400-e29b-41d4-a716-446655440000" defer data-patchstack-connect-widget="true"></script>
```

The before-build `scan` must finish before the compiler starts. The after-build `mark-build --strict` pass reads the same identity, stamps production/build metadata, and verifies exactly one usable widget in each complete built HTML document. Without `--dir`, it selects a known output only when exactly one of `dist/`, `build/`, `out/`, or `.output/public` contains complete HTML. Two or more populated candidates are ambiguous and fail before edits; persist `--dir <path>` for the tree actually deployed. Strict mode also fails for missing output, failed lockfile/stack coverage detection, unsafe identity, UUID mismatch, unreadable files, or failed production-marker verification.

Static HTML is the fully automatic production path. `mark-build --strict` rewrites and verifies complete deployable HTML documents and skips fragments. For frameworks capable of SSR/hybrid output (Next, Nuxt, TanStack Start, Remix/React Router, Astro, SvelteKit, Qwik City, Gatsby, Express, or Fastify), strict mode deliberately fails before editing output unless `--static-output` is also present. That flag is an explicit assertion that **every deployed route** is represented by complete static HTML. Use `mark-build --strict --static-output` only after verifying that fact from framework configuration and route inventory—never merely because `dist/` contains a prerendered route or error page. If any route is dynamic/hybrid, do not use the assertion; implement and test the framework/runtime production signal on a real dynamic response instead. The managed static tag carries `data-production="true"`; a shared SSR tag must set an equivalent signal conditionally in production, never in development preview.

If source discovery cannot select every safe editable global shell in its coverage group, create or repair the framework roots and rerun rather than injecting from a JS entry point/effect or guessing between candidates. A mixed Next App + Pages Router app is intentionally covered in both roots, while duplicate alternatives inside one router family remain ambiguous. Once the source invariant passes, `mark-build --strict --dir <path>` is fully automatic for complete static output.

For sites with a strict Content Security Policy, allow the widget CDN under `script-src`, the configured Patchstack API under `connect-src`, and account for the inline build marker and widget-injected styles. Nonce/hash-only policies may require a policy-specific integration; do not broadly weaken CSP just to enable the widget.

## Quick start (existing site)

If you already created an "Application" site in the Patchstack dashboard, pre-seed the UUID:

```bash
npm install --save-dev @patchstack/connect
npx --no-install patchstack-connect init <your-site-uuid>
npx --no-install patchstack-connect scan
```

## CLI

```
patchstack-connect scan   [options]                Scan the lockfile, POST to Patchstack, and
                                                   ensure the widget in a safe source shell.
                                                   If no UUID is configured the server provisions
                                                   one and the connector persists it.
patchstack-connect init   <site-uuid>              Optional: pre-seed .patchstackrc.json with
                                                   an existing site UUID
patchstack-connect status [options]                Show current configuration
patchstack-connect mark-build [options]            Stamp built HTML with a production flag +
                                                   build fingerprint, ensure the CDN widget,
                                                   and optionally verify it strictly
                                                   (run as a postbuild step)
patchstack-connect guide [--full]                  Show this project's setup status (what's done,
                                                   what's missing, with tailored commands), then
                                                   print the full setup guide
patchstack-connect protect                         Opt-in: install the always-on runtime exploit
                                                   guard (currently TanStack Start + Supabase; it
                                                   patches the app's Supabase client to route
                                                   traffic through a same-origin guard). Never
                                                   run by scan/guide/mark-build.
patchstack-connect help                            Print help

Options (for scan and status):
  --site-uuid <uuid>      Override the configured site UUID
  --endpoint <url>        Override the API endpoint
  --dry-run               (scan only) Print the payload without posting or editing source

Options (for mark-build):
  --site-uuid <uuid>      Override the configured site UUID
  --endpoint <url>        Override the API endpoint used by the widget
  --dir <path>            Override the build output directory
  --strict                Exit non-zero unless production HTML/widget verification succeeds
  --static-output         With --strict, assert every deployed route is complete static HTML
                          (required for detected SSR-capable frameworks; never use for SSR/hybrid)
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
  "endpoint": "https://api.patchstack.com/monitor/pulse/manifest"
}
```

The connector currently places `siteUuid` in client-side HTML. Under the current backend semantics that same value also authorizes manifest writes and unclaimed-site claiming, so it must **not** be described as non-secret or safe to commit; that mismatch blocks release. After the required credential split, configuration must clearly distinguish the non-authorizing widget identifier (repository/client safe) from manifest-write and one-time claim credentials (secret storage only). Provisioning/adoption must still persist the effective endpoint with the identity so custom/staging sites are never sent to production accidentally. Until that new schema/protocol lands, do not commit `.patchstackrc.json` or deploy automatic embedding outside a disposable security test.

Widget management defaults to enabled. To keep dependency scans but remove the widget, persist the opt-out before deleting the connector-managed source tag:

```json
{
  "siteUuid": "550e8400-e29b-41d4-a716-446655440000",
  "widget": false
}
```

Both `scan` and `mark-build` honor `"widget": false`; without it, a later scan restores the managed source tag.

## Programmatic API

```ts
import { scanAndReport } from '@patchstack/connect';

const result = await scanAndReport();
console.log(result.response.stored ? 'Reported' : 'Unchanged');
```

`scanAndReport()` is a reporting API, not the complete installation workflow: it does not run the CLI's safe source-shell preflight/injection or same-checkout provisioning lock. Use the installed `patchstack-connect scan` command when you want the automatic UUID-to-widget lifecycle described above.

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

That's the entire network payload. No source code, environment-variable values, or file paths are uploaded — just the package names and versions from your lockfile. After a successful non-dry response has a UUID, `scan` may locally edit one allowlisted source shell to ensure the widget; source is never uploaded. `mark-build` separately edits built HTML and stamps it with a stack descriptor that may include hosting-related environment-variable *names* such as `VERCEL`, never their values. Duplicate names with different versions are preserved so transitive vulnerabilities aren't missed.

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

For the maintained end-to-end local connector and static-build fixture, see [`testConnect/README.md`](https://github.com/patchstack/connect/tree/main/testConnect). Its normal scan/build flow performs a real Patchstack API request; follow its security warning and use it only as disposable local test data.

### Manifest endpoint testing

To post the current lockfile manifest to a local Patchstack API endpoint and provision a new site:

```bash
bun run test:manifest -- --endpoint http://localhost:8000/monitor/pulse/manifest
```

The response should include the new site UUID. To re-test an existing site, pass that UUID explicitly:

```bash
bun run test:manifest -- --endpoint http://localhost:8000/monitor/pulse/manifest --site-uuid YOUR_REAL_UUID
```

Use `--dry-run` to preview the payload without posting or editing a source shell.

## Release process

Pull requests run typecheck, tests, build, package verification, and a production dependency audit in GitHub Actions.

Publishing runs when a GitHub Release is published. The GitHub release tag is the source of truth for the published version: the workflow strips the leading `v` and runs `npm version` in its checkout before verification and publishing. The checked-in development version in `package.json` therefore does not need to match the release tag.

The automatic UUID-to-widget flow documented in this branch is not present in the currently published npm `0.3.5`. Deployment order is part of the compatibility contract: first close the credential-separation security gate above and verify authorization/migration end to end; then deploy and verify the rolling widget bundle with `data-production` support; then release this connector as an unused version greater than `0.3.5` (`v0.3.6` is the minimum expected tag), verify it on npm; and only then deploy the matching `patchstack-website` `install.txt`, `llms.txt`, and `uninstall.txt`. Reversing or skipping that order would expose write/claim authority or make the public guide promise unavailable behavior.

Maintainer reliability note: the connector serializes first-site provisioning processes in the same checkout and re-reads config after acquiring that local lock. That prevents two ordinary local/CI processes sharing the workspace from provisioning twice. It cannot make a timed-out request idempotent after the server has already committed, nor coordinate separate checkouts. Before describing first-site creation as exactly-once, the manifest API must accept and persist an idempotency key for bare provisioning requests; client-side locking alone cannot close that network boundary.

To publish a release:

1. Change the backend/API so the widget identifier cannot write manifests or claim a site; issue separate authenticated write and one-time scoped claim credentials. Update connector configuration/protocol, migration, redaction, rotation/replay, and end-to-end negative-authorization tests.
2. Deploy the tested `sass-webvdp-widget` build to `https://cdn.patchstack.com/patchstack-widget.js` and verify `data-production="true"` produces the production/report-only mode while omitted/false preserves development preview behavior.
3. Merge the tested connector feature changes to `main`.
4. Choose an unused semver greater than the live npm version and create a GitHub Release with its `v`-prefixed tag, for example `v0.3.6`.
5. The `Publish` workflow derives the package version from that tag, verifies the package, then runs `npm publish --provenance --access public`.
6. Verify the new version with `npm view @patchstack/connect version` and a clean install/scan/static-build smoke test, plus a hybrid-SSR route-coverage test where applicable.
7. Deploy the coordinated website instructions only after backend, CDN, and registry verification succeed.

Trusted publishing must remain configured for releases. To set it up or recover the configuration:

1. Merge `.github/workflows/publish.yml` to `main`.
2. Open the `@patchstack/connect` package settings on npmjs.com.
3. In **Trusted publishing**, choose **GitHub Actions**.
4. Configure:
   - Organization/user: `patchstack`
   - Repository: `connect`
   - Workflow filename: `publish.yml`
   - Environment name: `npm`
5. In GitHub repository settings, create an `npm` environment. Optional but recommended: require reviewer approval for that environment.

Do not add an npm publish token to GitHub secrets for this workflow. Trusted publishing uses GitHub OIDC short-lived credentials. Once trusted publishing is working, npm recommends setting package publishing access to require two-factor authentication and disallow tokens.

## License

MIT
