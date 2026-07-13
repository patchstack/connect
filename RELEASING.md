# Releasing

The version in `package.json` is the single source of truth. The published npm
version, the git tag, and the GitHub release must all match it — the `Publish`
workflow enforces this and will fail the release if they drift.

## Recommended: one-click release

Run the **Release** workflow (Actions → Release → Run workflow) on the branch you
want to release from (normally `main`):

- **bump**: `patch` / `minor` / `major`, or
- **version**: an explicit version like `0.3.3` (overrides `bump`).

The workflow bumps `package.json`, commits, tags, pushes, publishes to npm, and
cuts the GitHub release — all from the same version, so the tag can never
disagree with `package.json`.

## Manual release (fallback)

If you create a release/tag by hand in the GitHub UI, you **must** bump
`package.json` to the matching version first and merge that commit into the
branch you tag. Cutting `v0.3.3` while `package.json` still says `0.2.11` is
exactly what the guard rejects.

1. `npm version 0.3.3` on the release branch (bumps + commits + tags).
2. `git push origin HEAD --follow-tags`.
3. Create the GitHub release from tag `v0.3.3` → the `Publish` workflow runs.
