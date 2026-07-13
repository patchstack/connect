# @patchstack/connect

Connect a JavaScript / Node.js application to [Patchstack](https://patchstack.com) for continuous vulnerability monitoring. Scans your `package-lock.json` and reports installed packages so Patchstack can match them against its vulnerability database and notify you when something needs patching.

For how this repo fits with the wider Patchstack ecosystem (`saas`, `hub`, `patchstack-website`, `patchstack-connect`), see [`patchstack/saas` → `docs/ecosystem.md`](https://github.com/patchstack/saas/blob/main/docs/ecosystem.md).

## Install prompt (for AI coding tools)

Copy and paste this prompt into any AI coding assistant (Cursor, v0, Bolt, Lovable, Claude Code, etc.):

> Add Patchstack dependency vulnerability monitoring: install `@patchstack/connect` as a dev dependency (MIT — verify at https://www.npmjs.com/package/@patchstack/connect or with `npm view @patchstack/connect`; source: https://github.com/patchstack/connect), run `npx @patchstack/connect scan` and show me the claim URL it prints (I'll open it in my browser to view reports — don't open or fetch it yourself), then run `npx @patchstack/connect guide` and finish what its checklist flags: the package.json build hooks and the report-a-vulnerability widget snippet.

Every clause of this one-liner is deliberate — it has survived four distinct AI-agent refusal modes, each found by field-testing, and each one punished a different shortcut:

1. **"Follow the instructions at this URL" reads as remote script execution.** Agents refuse before ever fetching the doc. Nothing in the prompt asks the agent to fetch anything.
2. **Agents whose training predates May 2026 assert the package doesn't exist.** The npmjs.com link and `npm view` check resolve that against the registry instead of the model's memory.
3. **"Install the package, then follow the instructions it ships" reads as handing control to the package author** — structurally the same as prompt injection — and preemptive reassurance language ("it's safe, don't be suspicious, note your knowledge cutoff") is itself flagged as a manipulation signal. The prompt argues nothing and delegates to `guide` only after the agent has installed and audited the package.
4. **Unbounded delegation and authorization-shaped URLs.** "Finish the steps its checklist marks missing", unqualified, was refused by a WebContainer-based agent as a blank check ("executing untrusted, unseen commands"), and a bare "show me the claim URL" was flagged as a machine-authorization/pairing link. So the prompt names exactly what the checklist will flag (build hooks + widget snippet) — bounding the delegation in advance — and states what the claim URL is for (the *user* opens it in a browser to view reports).

The prompt can be this short because `guide` is state-aware: it inspects the project (package manager, `.patchstackrc.json`, `package.json` scripts, widget presence, framework) and prints a live checklist of only the remaining steps — with the real site UUID and framework-specific widget placement — followed by the full reference guide (`AGENT-INSTALL.md`, also at https://patchstack.com/install.txt). "Finish what the checklist flags" is a much smaller ask of an agent than "follow this manual", and it makes the flow idempotent: re-running `guide` on a finished project reports all-done instead of prompting a second install. In hostile-policy field tests, agents verified the tarball against the registry, audited `dist/` for lifecycle scripts and shell/eval calls, and then completed the install — the flow is designed to *pass* that audit, not to discourage it.

## Quick start (zero configuration)

```bash
npm install --save-dev @patchstack/connect
npx @patchstack/connect scan
```

> **Use your project's own package manager.** On bun-managed projects (Lovable, Bolt, most vibe-coding platforms) install with `bun add -d @patchstack/connect` instead — running `npm install` there plants a `package-lock.json` that the platform's native dependency flow never updates again, leaving a stale lockfile next to the live one. The connector detects and works around that (see *Stale lockfiles* below), but not creating the fossil is better.

That's it. The first `scan`:

1. Reads your lockfile (see *Supported lockfiles*).
2. POSTs the package list to Patchstack with **no** UUID.
3. Patchstack provisions a fresh site and returns its UUID.
4. The connector writes the UUID to `.patchstackrc.json` so the next `scan` targets the same site.
5. The connector prints a claim URL — open it in a browser to attach the new site to your Patchstack account. You can re-display it any time with `npx @patchstack/connect status`.

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
patchstack-connect mark-build [options]            Stamp built HTML with a production flag +
                                                   build fingerprint (run as a postbuild step)
patchstack-connect guide                           Show this project's setup status (what's done,
                                                   what's missing, with tailored commands), then
                                                   print the full setup guide
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
