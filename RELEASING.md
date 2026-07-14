# Releasing

The **git tag is the single source of truth** for a release. The `Publish`
workflow reads the version from the tag (`v0.3.3` → `0.3.3`), writes it into
`package.json` in CI, then builds and publishes. Nothing is committed back to
`main`, so this works with branch protection and the tag can never disagree
with the published version.

`package.json`'s committed `version` is just a placeholder — it does not need to
be bumped before a release.

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

## Notes

- Tags must be `vX.Y.Z` (the leading `v` is stripped to get the npm version).
- For a manual release, pick a version higher than the current `latest` on npm
  (`npm view @patchstack/connect version`); npm rejects re-publishing an
  existing version. The `Release` workflow handles this for you.
- Run `Publish` via **workflow_dispatch** with a blank `version` for a dry-run
  publish without cutting a release.
