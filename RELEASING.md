# Releasing

The **git tag is the single source of truth** for a release. The `Publish`
workflow reads the version from the tag (`v0.3.3` → `0.3.3`), writes it into
`package.json` in CI, then builds and publishes. The tag can therefore never
disagree with the published version, and nothing has to be committed before a
release — which is what makes this work with branch protection.

You do **not** bump `package.json` before releasing. After a successful publish,
the `Publish` workflow opens a pull request on `chore/record-published-version`
bringing `package.json` and `package-lock.json` up to the version that was just
published. Merge it; it is two version strings and the lockfile entries `npm
version` derives from them.

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
actually resolved. A pull request opened by `GITHUB_TOKEN` does not start
workflow runs, so `Publish` runs that test itself and states the result in the
pull request body; close and reopen the pull request if you want the full suite
to run on it.

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
