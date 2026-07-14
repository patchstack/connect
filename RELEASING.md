# Releasing

The **git tag is the single source of truth** for a release. The `Publish`
workflow reads the version from the tag (`v0.3.3` → `0.3.3`), writes it into
`package.json` in CI, then builds and publishes. Nothing is committed back to
`main`, so this works with branch protection and the tag can never disagree
with the published version.

`package.json`'s committed `version` is just a placeholder — it does not need to
be bumped before a release.

> **Release authorization is separate from release mechanics.** These workflows
> do not know whether a product or security release blocker is open. Check the
> blockers in `README.md` before dispatching either workflow. In particular, do
> not release the automatic UUID-to-widget flow until credential separation,
> authorization/migration tests, and the CDN rollout are complete in the order
> documented there.

## How to release (recommended)

Run the **`Release`** workflow from the Actions tab on `main` (or `gh` below) and pick a
`bump` — `patch`, `minor`, or `major`. It reads the current release state,
computes the next available semver version, cuts the GitHub release + tag on the current
`main`, and then dispatches `Publish` for that version. `Publish` validates
(typecheck, test, build, `npm pack`) and publishes to npm with provenance,
recording a deployment to the `npm` environment linked to the published version.

```bash
gh workflow run release.yml --ref main -f bump=patch
```

No manual version math or `npm view` lookup is needed. The workflow computes the
version and fails before creating a release if that tag already exists.

`Release` triggers `Publish` explicitly via `workflow_dispatch` rather than
relying on the release event. This is deliberate: GitHub does **not** fire
`release`-triggered workflows for releases created by the built-in
`GITHUB_TOKEN` (an anti-recursion safeguard), and `workflow_dispatch` is the
one event type that is exempt.

## Manual fallback

You can still cut a release by hand. Because a human token (not `GITHUB_TOKEN`)
creates it, the release event fires `Publish` on its own:

```bash
gh release create v0.3.3 --target main --generate-notes --title "v0.3.3"
```

or use the GitHub UI (Releases → Draft a new release → new tag `v0.3.3`).

You can also publish an existing tag directly:

```bash
gh workflow run publish.yml --ref v0.3.3 -f version=0.3.3
```

Use the existing-tag path only to recover an approved release whose tag was
created but whose npm publish did not complete. First inspect the release and
tag, confirm that npm does not already contain the version, and re-check every
release blocker:

```bash
gh release view v0.3.3
git show --stat v0.3.3
npm view @patchstack/connect@0.3.3 version
```

Selecting the same tag with `--ref` makes the dispatch validate and publish that
tagged tree; it does not
include newer changes from `main` or the caller's branch. Do not move or recreate
a release tag merely to include later work—use a new version after resolving the
stale release according to the repository's release policy.

## Notes

- Tags must be `vX.Y.Z` (the leading `v` is stripped to get the npm version).
- For a manual release, pick a version higher than the current `latest` on npm
  (`npm view @patchstack/connect version`); npm rejects re-publishing an
  existing version. The `Release` workflow handles this for you.
- Run `Publish` via **workflow_dispatch** with a blank `version` for a dry-run
  publish of the selected ref without cutting a release. A dry-run is validation,
  not authorization to publish while a blocker remains open.
