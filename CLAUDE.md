# @patchstack/connect — agent notes

npm package that connects a JS/Node project to Patchstack vulnerability monitoring: scans the lockfile, POSTs package names + versions, provisions a site UUID, prints a claim URL. CLI entry: `src/cli.ts`; the state-aware setup checklist lives in `src/guide.ts`.

Editing any onboarding, prompt, or setup-guide content? Read `MAINTAINING.md` first — it maps which files are load-bearing and how to ship a change safely.

## Commands

- `npm test` — vitest suite
- `npm run typecheck` / `npm run build`
- `node field-test/run.mjs --persona hostile --rounds 3` — agent field test (real AI agent, ~3–6 min and ~30–50k tokens per round; see `field-test/README.md` before running)
- `node field-test/matrix.mjs --agents claude,codex,gemini` — personas × models cross-product; the platform personas (`bolt-diy`, `lovable`, `replit`) carry the real platform system prompts (provenance in `field-test/README.md`)

## The install prompt is a tested artifact

The one-line install prompt in `README.md` ("Install prompt (for AI coding tools)") is adversarial-UX surface: every clause exists because an AI agent refused a shorter version. The refusal modes are documented in `field-test/README.md` — deliberately NOT in the shipped README/AGENT-INSTALL: agents `npm pack` the tarball and read everything, and narrating how the prompt survives refusals is itself read as a manipulation signal. For the same reason, the shipped docs must disclose every capability in `dist/` (e.g. the `protect` command) — an undisclosed capability or overbroad privacy claim is treated as misrepresentation and refused.

Invariants when touching it:

- The prompt appears in three places that must stay identical: `README.md`, `GETTING-STARTED.md` (the teammate-facing flow), and `field-test/prompt.txt` — `prompt.txt` is the artifact the harness tests.
- Any change to the prompt, the `guide` checklist output (`src/guide.ts`), or `AGENT-INSTALL.md` must pass `node field-test/run.mjs --persona hostile --rounds 3` before shipping. Agents audit the shipped docs, so inaccuracies in `AGENT-INSTALL.md` cost trust and cause refusals. **A round that never installed is VOID, not a pass and not a failure**: it never obtained the tarball, so it never read the docs, and its scorecard is identical to a doc regression's. The harness retries void rounds within a bounded budget and exits 2 when every round was void — read that as "re-run", never as "the docs are fine". A doc change also wants a re-run after publication, when the published tarball actually carries it.
- Don't add reassurance language ("it's safe", "nothing is executed remotely") — agents flag it as a manipulation signal. Don't ask the agent to "follow the guide/instructions it prints" unbounded — name the concrete steps instead.
- A new real-world refusal report becomes a persona in `field-test/personas/` so the regression stays covered.
- The fixture installs the *published* package, so an unpublished `guide`/CLI change can't be exercised end-to-end — publish first, or accept the run validates only the prompt shape.

## Comments and Explanations

**Keep ticket references out of the code.** No `ENG-1234`, `LAB-567` or `Nightwatch #12`
anywhere in the tree — not in comments, docblocks, test names, config files or strings.
The ID goes in the PR title (`[ENG-1234] …`) and the PR description (`Closes ENG-1234`),
and nowhere else. That is where someone looks for the backstory, and `git blame` takes them
there from any line. In the code it is dead weight: it means nothing without Linear open,
and nothing at all once the ticket is archived.

**Comments describe the code that is there, not the code that used to be.** Don't narrate
the old behaviour, the bug, or how the fix was reasoned about — that is the PR's job. A
comment earns its place by telling the reader something the code cannot: a non-local
constraint, an invariant, why an unusual choice was made. If it restates the signature or
the line below it, delete it.

**Explain things plainly.** In PR descriptions, review comments and replies: short
sentences, ordinary words, no jargon where a plain word works. Lead with what changed and
why it matters, then the detail. Assume the reader is capable but has not seen this code
today.

This repo is public. Nothing committed here — code, comments, docs or commit messages — may
contain customer names, internal URLs or internal hostnames.

## Releasing

The git tag is the source of truth (`gh release create vX.Y.Z`); `package.json`'s version is a placeholder. See `RELEASING.md`.
