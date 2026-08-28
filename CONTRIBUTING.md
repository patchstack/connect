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
# .node-version records the version releases are built with (24). fnm, nodenv and asdf read it directly;
# nvm looks for .nvmrc, so it needs the file passed in.
nvm use "$(cat .node-version)"     # or: fnm use / nodenv local
npm ci
```

Consumers are supported from Node 18 — `engines.node` is that contract, and it is a different question
from the version this repository is developed and released on.

## The loop

```bash
npm run typecheck  # tsc --noEmit, plus the guard templates, which are typechecked separately
npm run build      # tsup -> dist/ (gitignored; built on publish)
npm test           # vitest
```

Build before testing, in that order. `dist/` is not committed, and several tests only run once it exists —
they skip in a plain checkout and are required in CI. Run in the other order and those tests skip, which
reads exactly like passing.

## Before you open a pull request

- `npm run typecheck`, `npm run build`, `npm test` all clean — in that order, for the reason above.
- `npm pack --dry-run` if you touched anything about packaging. `files` in `package.json` is the
  authoritative allowlist of what ships.
- `npm run test:consumers` if you touched `exports`, `files`, the build config or anything about types. It
  packs a real tarball, installs it into isolated consumer projects and checks every shape a consumer can
  use — ESM and CommonJS, JavaScript and TypeScript, the installed bin, and that nothing outside `exports`
  is reachable. Nothing else can see those: they are decided by the tarball's metadata rather than by the
  code, so the source suite passes while a consumer cannot import the package at all. CI runs it across
  npm, pnpm, Yarn and Bun, plus a Windows smoke test.
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
| `rule-contract.json` | the engine's match types and actions | `npm run rule-contract` |
| the canary attack-surface map | `tests/map/canary-case.ts` | `PS_CANARY_EMIT_DIR=<dir> npx vitest run tests/map/canary-emit` |

A vocabulary change to `capabilities.json` also needs `CAPABILITY_VERSION` moved. `npm run
capabilities:check` and `npm run rule-contract:check` are what CI runs.

## Comments and prose

- Comments describe the code that is there and the invariant it holds — not the code that used to be, and
  not how a fix was reasoned about.
- **The same applies to a pull-request description**, which is public. State what changed and the
  externally observable reason it matters. "What used to happen", "how we found it" and the mutations you
  tried belong in the private engineering record, not here — see the boundary in `AGENTS.md`.
- No ticket references anywhere in the tree. They go in the pull-request title and description.
- Plain words, short sentences. Lead with what changed and why it matters.

## Reporting a bug

Use the bug-report form, which asks for the versions and the reproduction that make a report actionable —
and asks you to confirm it carries no credentials, customer data or private implementation details. If a
report cannot be written without those, contact Patchstack support instead of filing it here.

Think you have found a security vulnerability in this package? Do not open an issue — see `SECURITY.md`
if present, or contact Patchstack support directly.
