# Releasing

The **git tag is the single source of truth** for a release. The `Publish`
workflow reads the version from the tag (`v0.3.3` → `0.3.3`), writes it into
`package.json` in CI, then builds and publishes. The tag can therefore never
disagree with the published version, and nothing has to be committed before a
release — which is what makes this work with branch protection.

You do **not** bump `package.json` before releasing. After a successful publish,
the `Publish` workflow opens a pull request on `chore/record-published-version`
bringing `package.json` and `package-lock.json` up to the version that was just
published. When the proposal App is configured, this pull request merges after
the publishing run and its required CI checks pass. Without the App, it remains
for a maintainer to merge. The change contains only two version strings and the
lockfile entries `npm version` derives from them.

That pull request is not bookkeeping. Five surfaces answer the question "which
version is this?" — the manifest, the two places the lockfile records it, the
tarball name `npm pack` derives, an SBOM built from a checkout, and
`patchstack-connect --version`. Only the published tarball gets its answer from
the tag; everything read out of the repository gets it from the committed
manifest. For a package whose purpose is to shield known vulnerabilities, a
manifest naming the wrong version is not untidiness: it is someone believing
they have a fix they do not have. Merging keeps the two in step.

`tests/package-version.test.ts` pins the surfaces that can be checked from the
repository, and the consumer matrix
(`npm run test:consumers`) proves the installed binary reports the version npm
actually resolved. `Publish` runs the version check and records its result in
the pull request body. A proposal opened with the App receives normal PR CI;
one opened with the workflow token may need a maintainer to approve those runs.

When the proposal App is configured, a verified published tarball also triggers
freshness checks in configured downstream repositories. Set the
`RELEASE_REFRESH_TARGETS` Actions secret to a JSON array of repository names
owned by the same organization; keep those names out of this public repository
and its workflow logs. The App must be installed on each target with Contents
write permission. A notification failure makes `Publish` red without undoing the
already-published package. A dry-run or failed tarball verification sends no
notification.

## How to release (recommended)

Run the **`Release`** workflow from the Actions tab (or `gh` below) and pick a
`bump` — `patch`, `minor`, or `major`. It reads the current `latest` from npm,
computes the next semver version, cuts the GitHub release + tag on the current
`main`, and then dispatches `Publish` for that version. `Publish` validates
(typecheck, test, build, `npm pack`) and publishes to npm with provenance,
recording a deployment to the `npm` environment linked to the published version.

```bash
gh workflow run Release -f bump=patch
```

No version math, no `npm view` lookup, no chance of colliding with an existing
version — the workflow does all of that.

**`patch` is the default, and it is the wrong choice for some changes.** Raising
the `engines.node` floor, removing or renaming an export, and changing what a
shipped default does are all compatibility breaks, and which bump they need
depends on where the version is:

- **while this package is `0.x`** — at least a `minor`. A caret range on a `0.x`
  version does not cross the minor, so `0.5.0` is what keeps the break away from
  an installer resolving `^0.4.x`.
- **from `1.0` onward** — a `major`. A caret range then spans every minor, so a
  minor would deliver the break to exactly the installers it has to be kept from.

The release that carries the floor move to `>=20` is therefore **`0.5.0`**:
`gh workflow run Release -f bump=minor`. The workflow cannot infer any of this,
so it is the caller's to pass.

`Release` triggers `Publish` explicitly via `workflow_dispatch` rather than
relying on the release event. This is deliberate: GitHub does **not** fire
`release`-triggered workflows for releases created by the built-in
`GITHUB_TOKEN` (an anti-recursion safeguard), and `workflow_dispatch` is the
one event type that is exempt.

## Manual fallback

You can still cut a release by hand. Because a human token (not `GITHUB_TOKEN`)
creates it, the release event fires `Publish` on its own:

```bash
gh release create v0.3.3 --generate-notes --title "v0.3.3"
```

or use the GitHub UI (Releases → Draft a new release → new tag `v0.3.3`).

You can also publish an existing tag directly:

```bash
gh workflow run publish.yml -f version=0.3.3
```

## Before publishing detection reporting

Detection reporting depends on two server-side behaviours. Check both before cutting a
release that includes it, because a published version cannot be withdrawn from anyone
who has already installed it:

- **The detections endpoint deduplicates on `Idempotency-Key`.** Connect sends a stable
  key for every attempt at a batch and a fresh one per batch, so a redelivery is
  identifiable — but whether it is counted once is the endpoint's to decide. Published
  ahead of that, a retry after a lost acknowledgement inflates the counts these reports
  are read for.
- **Ingest accepts and stores the current payload:** the `capture` object, the baseline
  fields `method`, `user_agent`, `query_keys` and `query_keys_total`, and
  `reporting_state` on the detections body. An endpoint that rejects or silently drops
  them turns every report into a delivery failure, or into a record missing the evidence
  it was sent to carry.

Delete this section once both have shipped.

## npm trusted publishing

This is configured already; it is recorded here so the settings can be checked or rebuilt.

1. `.github/workflows/publish.yml` is on `main`.
2. In the `@patchstack/connect` package settings on npmjs.com, **Trusted publishing** is set to
   **GitHub Actions** with organization `patchstack`, repository `connect`, workflow filename
   `publish.yml`, environment name `npm`.
3. An `npm` environment exists in the GitHub repository settings. Requiring reviewer approval on it is
   optional and recommended.

There is deliberately **no npm publish token** in GitHub secrets for this workflow — trusted publishing
uses short-lived GitHub OIDC credentials instead. npm's own recommendation, once a trusted publish has
succeeded, is to set the package's publishing access to require two-factor authentication and disallow
tokens.

## Notes

- Tags must be `vX.Y.Z` (the leading `v` is stripped to get the npm version).
- For a manual release, pick a version higher than the current `latest` on npm
  (`npm view @patchstack/connect version`); npm rejects re-publishing an
  existing version. The `Release` workflow handles this for you.
- Run `Publish` via **workflow_dispatch** with a blank `version` for a dry-run
  publish without cutting a release.
