# Contributing to `@patchstack/connect`

The human counterpart to `AGENTS.md`. Same boundary, same verification; this one explains the setup.

## Before anything else: this repository is public

Its history, code comments, test output, commit messages and pull-request descriptions are all public, and
so is anything you paste into an issue.

`AGENTS.md` carries the boundary in full and is worth reading once. The two rules that catch people:

- **Nothing from private Patchstack systems** unless it is already in this repository's public
  documentation or public API contract — no private repository names or paths, no internal topology or
  endpoints, no customer or vulnerability-review data, no local filesystem paths.
- **Nothing third-party confidential**, which is a separate obligation and not a special case of the
  first: copied system prompts, private transcripts, unpublished documentation. Material can be entirely
  free of Patchstack internals and still not be ours to publish. Verify that something is public rather
  than assuming it.

Fixtures are synthetic or explicitly public. Do not copy one from a private repository to make a test more
realistic — write it.

## Setup

```bash
nvm use            # reads .node-version (24). Consumers are supported from 18; see engines.node.
npm ci
```

## The loop

```bash
npm run typecheck  # tsc --noEmit, plus the guard templates, which are typechecked separately
npm test           # vitest
npm run build      # tsup -> dist/ (gitignored; built on publish)
```

`dist/` is not committed. A few tests only run once it exists — they skip in a plain checkout and are
required in CI, so run `npm run build` before trusting a green local run of the whole suite.

## Before you open a pull request

- `npm run typecheck`, `npm test`, `npm run build` all clean.
- `npm pack --dry-run` if you touched anything about packaging. `files` in `package.json` is the
  authoritative allowlist of what ships.
- Read your own diff, commit messages and pull-request description against the boundary above. The
  pull-request template asks you to confirm this; it is the only control that covers prose, because secret
  scanning finds credentials and nothing finds a paragraph of architecture.

Changing onboarding, the install prompt or the setup guide? Read `MAINTAINING.md` first — it maps which
files are load-bearing — and note that the install prompt is a tested artifact with its own gate in
`field-test/`.

## Generated artifacts that must stay in step

Each of these is generated from a source of truth and committed. Changing the source without regenerating
leaves two files disagreeing, and the check that notices is not always the one that fails first:

| artifact | generated from | regenerate with |
|---|---|---|
| `capabilities.json` | `src/map/capabilities.ts` | `node scripts/emit-capabilities.mjs` |
| `rule-contract.json` | the engine's match types and actions | see `src/protect/rules/contract.js` |
| the canary attack-surface map | `tests/map/canary-case.ts` | `PS_CANARY_EMIT_DIR=<dir> npx vitest run tests/map/canary-emit` |

A vocabulary change to `capabilities.json` also needs `CAPABILITY_VERSION` moved; CI checks that.

## Comments and prose

- Comments describe the code that is there, not the code that used to be, and not how a fix was reasoned
  about. That belongs in the pull request.
- No ticket references anywhere in the tree. They go in the pull-request title and description.
- Plain words, short sentences. Lead with what changed and why it matters.

## Reporting a bug

Use the bug-report form, which asks for the versions and the reproduction that make a report actionable —
and asks you to confirm it carries no credentials, customer data or private implementation details. If a
report cannot be written without those, contact Patchstack support instead of filing it here.

Think you have found a security vulnerability in this package? Do not open an issue — see `SECURITY.md`
if present, or contact Patchstack support directly.
