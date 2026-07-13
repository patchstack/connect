# Releasing

The **git tag is the single source of truth** for a release. The `Publish`
workflow reads the version from the tag (`v0.3.3` → `0.3.3`), writes it into
`package.json` in CI, then builds and publishes. Nothing is committed back to
`main`, so this works with branch protection and the tag can never disagree
with the published version.

`package.json`'s committed `version` is just a placeholder — it does not need to
be bumped before a release.

## How to release

Create a GitHub release with a new tag:

```bash
gh release create v0.3.3 --generate-notes --title "v0.3.3"
```

or use the GitHub UI (Releases → Draft a new release → new tag `v0.3.3`).

Publishing the release triggers the `Publish` workflow, which validates
(typecheck, test, build, `npm pack`) and publishes to npm with provenance using
the tag's version.

## Notes

- Tags must be `vX.Y.Z` (the leading `v` is stripped to get the npm version).
- Pick a version higher than the current `latest` on npm (`npm view
  @patchstack/connect version`); npm rejects re-publishing an existing version.
- Run the `Publish` workflow via **workflow_dispatch** for a dry-run publish
  without cutting a release.
