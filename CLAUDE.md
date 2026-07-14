# @patchstack/connect — agent notes

npm package that connects a JS/Node project to Patchstack vulnerability monitoring: scans the lockfile, POSTs package names + versions, provisions a site UUID, prints a claim URL. CLI entry: `src/cli.ts`; the state-aware setup checklist lives in `src/guide.ts`.

Editing any onboarding, prompt, or setup-guide content? Read `MAINTAINING.md` first — it maps which files are load-bearing and how to ship a change safely.

## Commands

- `npm test` — vitest suite
- `npm run typecheck` / `npm run build`
- `node field-test/run.mjs --persona hostile --rounds 3` — agent field test (real AI agent, ~3–6 min and ~30–50k tokens per round; see `field-test/README.md` before running)

## The install prompt is a tested artifact

The one-line install prompt in `README.md` ("Install prompt (for AI coding tools)") is adversarial-UX surface: every clause exists because an AI agent refused a shorter version. The refusal modes are documented in `field-test/README.md` — deliberately NOT in the shipped README/AGENT-INSTALL: agents `npm pack` the tarball and read everything, and narrating how the prompt survives refusals is itself read as a manipulation signal. For the same reason, the shipped docs must disclose every capability in `dist/` (e.g. the `protect` command) — an undisclosed capability or overbroad privacy claim is treated as misrepresentation and refused.

Invariants when touching it:

- The prompt text appears in three places and must stay identical: `README.md`, `GETTING-STARTED.md` (the teammate-facing flow), and `field-test/prompt.txt` — `prompt.txt` is the plain-text artifact the harness tests, while the docs add Markdown blockquote syntax. `tests/docs.test.ts` enforces the invariant.
- Evaluate any change to the prompt, the `guide` checklist output (`src/guide.ts`), or `AGENT-INSTALL.md` with `node field-test/run.mjs --persona hostile --rounds 3` before shipping. If stale published artifacts or release freshness make that gate environmentally red, follow the plan B in `field-test/README.md` and record the refusal reason. Never publish merely to make a field test exercise unpublished code.
- Don't add reassurance language ("it's safe", "nothing is executed remotely") — agents flag it as a manipulation signal. Don't ask the agent to "follow the guide/instructions it prints" unbounded — name the concrete steps instead.
- A new real-world refusal report becomes a persona in `field-test/personas/` so the regression stays covered.
- The fixture installs the *published* package, so it cannot exercise unpublished `guide`, CLI, README, or `AGENT-INSTALL.md` changes end-to-end. Use the plan B until the normal, approved release process is safe to run.

## Releasing

The git tag is the source of truth (`gh release create vX.Y.Z`); `package.json`'s version is a placeholder. See `RELEASING.md`.
