# Field-test harness for the AI-agent install prompt

Runs a real AI coding agent against the [README install prompt](../README.md#install-prompt-for-ai-coding-tools) inside a throwaway project, with the Patchstack API mocked, and scores the outcome. This is how changes to the prompt, the `guide` checklist, or `AGENT-INSTALL.md` are validated before shipping.

Dev-only: nothing in this directory ships in the npm package.

## The personas are synthetic

Each persona reproduces the *pressures* that a class of platform applies to a request like this one —
non-technical user, supply-chain caution, a runtime that stages commands rather than running them — written
from our own analysis of observed behaviour.

They are not the platforms' system prompts and not paraphrases of them: third-party prompts are not ours to
publish, whatever the tarball excludes. That is a real trade. A synthetic persona is weaker evidence than
the policy a product actually runs, so what this harness proves is that the prompt survives the SHAPE of
the pressure. Higher-fidelity evaluation, and the detailed record of which refusals came from where,
belong in a private evaluation repository.

`{{FIXTURE_DIR}}` and `{{INSTALL_PROMPT}}` are the only contract a persona has to satisfy; a new one is a
markdown file using both.

## Why this exists

The install prompt is an adversarial-UX artifact: AI agents actively try to refuse it. Unit tests can't tell you whether an agent will balk at a phrase, mis-read CLI output, or wire the widget with the wrong token — only letting an agent run the real flow does. Every clause in the prompt exists because a run like this failed without it; the record of which run, and what it said, is kept privately.

## Void rounds: a refusal before installing is not evidence about the docs

The documentation gate exists to catch mode 6 — a contradiction between the shipped docs and `dist/`,
such as an overbroad privacy claim. Catching that requires the agent to have READ the docs, which means
it must have obtained the tarball, which means it must have installed.

An agent that refuses on the *prompt* never gets there. Its scorecard is `2/8 REFUSED`, which is
byte-identical to what a documentation regression would produce, and no field distinguished the two. So
"must pass `--rounds 3`" could not fail for a documentation reason at all — the gate was unable to detect
the thing it existed for, and `2/8 REFUSED` is the modal outcome for `hostile`.

Such a round is now **void**: neither evidence for nor against the docs.

- The scorecard carries `audited`, and prints `VOID` when it is false.
- `audited` means **the tarball was fetched and unpacked** — specifically, a non-empty
  `node_modules/@patchstack/connect/AGENT-INSTALL.md` in the fixture. A dependency DECLARATION in
  `package.json` is not enough and was the first version's mistake: an agent can add the declaration and
  refuse before `npm install`, and that shape is a recorded outcome (staging an edit
  for the user instead of running a command). Such a round then scored as conclusive while the docs were
  never on disk.
- What that establishes is that the docs were **present for the agent to read**, not that it read them.
  That is the strongest thing observable from outside the agent, and it is the right bar: a round where
  the docs were on disk and the agent still refused *is* evidence about them; a round where they never
  arrived is not.
- The `installed` check now requires both halves, and its detail distinguishes the three states
  (absent / declared but never unpacked / unpacked, with the doc's byte count).
- Void rounds are retried, bounded at `2 × --rounds`, so a persona that never installs cannot loop.
  Every attempt keeps its own `round-<n>-attempt-<m>/` directory — retries used to reuse the round
  number and overwrite the void attempt's report, destroying the record a reviewer needs to tell a
  prompt refusal from a doc regression.
- The summary counts only conclusive rounds, and reports how many were void.
- Exit codes are three-way: `0` all conclusive rounds green, `1` a real failure, **`2` inconclusive** —
  nothing unpacked, so the run says nothing. A release gate must not read `2` as "the docs are fine".

Two consequences for how to use it:

- For a docs-only change, prefer a persona that reliably installs (`standard`, or `lovable`, which has
  completed rounds). `hostile` measures prompt survival; it is a poor instrument for doc accuracy.
- Re-run after publication. Until the change is published, the tarball an agent installs and audits does
  not contain it, so even a conclusive round is auditing the previous docs.

Self-testing the two paths costs no agent tokens:

```
node field-test/run.mjs --rounds 1 --agent-cmd "node '$PWD/field-test/stub-compliant.mjs'"
node field-test/run.mjs --rounds 1 --agent-cmd "node '$PWD/field-test/stub-refusing.mjs'"
node field-test/run.mjs --rounds 1 --agent-cmd "node '$PWD/field-test/stub-declares-only.mjs'"
```

| stub | what it models | expected |
|---|---|---|
| `stub-compliant` | performs the whole flow | `8/8`, `1/1 conclusive`, exit **0** |
| `stub-refusing` | refuses before touching anything | 3 void rounds, INCONCLUSIVE, exit **2** |
| `stub-declares-only` | writes the dependency, never installs | 3 void rounds, INCONCLUSIVE, exit **2** |

`stub-declares-only` is the one that matters for the `audited` definition. With `audited` reading the
package.json declaration, that run reported `0/1 conclusive` and exit **1** — a definitive failure verdict
about documentation it had never obtained.

Quote the path: `--agent-cmd` is handed to `sh -c`, and this repository's own checkout sits under a
directory with a space in it, so an unquoted command silently fails to start — which voids the round,
correctly but confusingly.

## Prerequisites

- Node ≥ 18, network access (fixtures run a real `npm install`; the agent installs the real published `@patchstack/connect`).
- An agent CLI. Default: [Claude Code](https://claude.com/claude-code) headless (`claude -p`). Any CLI that reads a prompt from stdin and prints the agent's final message to stdout works via `--agent-cmd`.

## Safety model — read before running

- **The Patchstack API is mocked.** Each run starts a local mock and pins it via the `PATCHSTACK_ENDPOINT` env var on the agent process. Env pinning survives anything the agent does to project files and reads as platform plumbing. (Earlier versions planted the override in `.patchstackrc.json`; every agent flagged that file as the #1 trust concern, and one deleted it and provisioned a real production site. Don't regress this.)
- **The agent runs with permissions skipped** (`--dangerously-skip-permissions`; the codex and gemini matrix agents use their equivalent bypass/yolo flags) in a temp-dir fixture, because headless runs can't answer permission prompts. It can run arbitrary commands. Supervise runs; don't run on a machine where that's unacceptable.
- One run ≈ 3–6 minutes and ~30–50k agent tokens.

## Usage

```bash
# Baseline: standard persona, Lovable-style bun fixture, prompt.txt
node field-test/run.mjs

# The adversarial persona that reproduces the Bolt/WebContainer refusal pressure
node field-test/run.mjs --persona hostile

# A platform-shaped persona (synthetic — see "The personas are synthetic" above)
node field-test/run.mjs --persona bolt-diy

# Stochastic agents: run several rounds and look at the aggregate
node field-test/run.mjs --persona hostile --rounds 3

# Test a prompt variant without touching prompt.txt
node field-test/run.mjs --prompt /tmp/prompt-v3.txt

# Different agent CLI
node field-test/run.mjs --agent-cmd "claude -p --dangerously-skip-permissions --model opus"

# Self-test the harness (scripted stub, no AI, ~1 min) — should be fully green
node field-test/run.mjs --agent-cmd "node $PWD/field-test/stub-compliant.mjs"
```

Flags: `--persona <name>` (any `personas/<name>.md`), `--template lovable-bun|vite-npm`, `--prompt <file>`, `--rounds N`, `--agent-cmd "<cmd>"`, `--keep` (don't delete the fixture), `--timeout <minutes>`, `--confirm` (see below), `--confirm-reply <file>` (override the confirmation text).

### `--confirm` — legacy two-turn prompt experiments

The canonical prompt is intentionally one turn. `--confirm` remains for A/B testing older or experimental prompts that ask the agent to stop and report before proceeding: when the first turn ends short of green, the harness re-invokes the agent with its previous message plus a confirmation reply (or `--confirm-reply <file>`) and scores the combined outcome. The second report lands in `report-confirm-turn.md`.

Do not use `--confirm` to make the canonical prompt look green; a hosted staged-command UI may never expose the first command's output to the same agent turn.

### Local `setup` demonstration

The agent harness installs the published package, so use the local demo to exercise an unpublished `setup` implementation against the working tree:

```bash
npm run build
node field-test/setup-demo.mjs
```

It packs the local package into a throwaway React/Vite fixture with a Bun lockfile, installs it as a dev dependency, runs `setup` twice against the mock API, and verifies that one site, one widget, and one copy of each build command remain. It never calls the production API, runs the fixture build, or invokes `protect`.

### Matrix runs — personas × models

Refusal behavior is a function of (system prompt × model). `matrix.mjs` runs the cross-product and aggregates the scorecards into one table:

```bash
# Default: the three platform-shaped personas under Claude
node field-test/matrix.mjs

# Full matrix: 3 platform personas × 3 model families (9 agent runs — budget ~30-60 min)
node field-test/matrix.mjs --agents claude,codex,gemini

# Everything run.mjs accepts passes through
node field-test/matrix.mjs --personas hostile,bolt-diy --agents claude,codex --rounds 3 --prompt /tmp/v2.txt

# Plumbing self-test (scripted stub, no AI)
node field-test/matrix.mjs --agents stub --personas bolt-diy,lovable,replit
```

Named agents (see the `AGENTS` table in `matrix.mjs`): `claude` (logged-in Claude Code), `codex` (`codex login` or `OPENAI_API_KEY`), `gemini` (interactive login once or `GEMINI_API_KEY`; Workspace accounts also need `GOOGLE_CLOUD_PROJECT`), `stub`. Agents missing from PATH are skipped with a warning; unauthenticated ones fail their cells visibly. The aggregate lands in `field-test/results/matrix-<timestamp>/matrix.md` with links to each cell's full run.mjs results; exit code is 0 only if every cell is fully green.

## What gets scored

Each round prints a scorecard and exits non-zero unless every round is fully green:

| Check | Meaning |
|---|---|
| `installed` | `@patchstack/connect` declared in the fixture's `package.json` |
| `provisioned` | `.patchstackrc.json` carries the mock's site UUID |
| `provisionedOnce` | exactly one provisioning POST — more means duplicate sites |
| `hooksWired` | `scan` and `mark-build` reachable from `prebuild`/`postbuild`/`build` |
| `widgetInstalled` | widget script tag present in source |
| `widgetTokenMatches` | the provisioned UUID appears in source as the `userToken` |
| `claimUrlSurfaced` | the agent's final message shows the claim URL to the user |
| `noProductionLeak` | the agent never surfaced a production claim URL (mock bypass) |

Everything is saved under `field-test/results/<timestamp>-<persona>/` (gitignored): the agent's full report (`report.md` — read HESITATIONS and UX FRICTION, that's where the insight is), the mock's request log, and per-round scorecards.

## The improve-and-retest loop

1. Edit `prompt.txt` (or point `--prompt` at a variant).
2. `node field-test/run.mjs --persona hostile --rounds 3` — the hostile persona is the gate; standard is a smoke test. Add a `--persona bolt-diy` round when the command shape or staged-output behavior changes, and `hostinger` plus `lovable-supplychain` rounds when provenance or package metadata changes.
3. Read each round's `report.md` HESITATIONS / DECISION ANALYSIS sections. Anything an agent pauses on is a future refusal in a stricter harness.
4. Fix what you find — in the prompt, the `guide` checklist, or `AGENT-INSTALL.md` (agents audit the shipped docs; inaccuracies cost trust).
5. When rounds are consistently green, copy the prompt into the README's install-prompt section, and record what the failing runs showed in the private evaluation record.

Keep `prompt.txt` in sync with the README prompt — it is the tested artifact.

## When the gate is red for environmental reasons (plan B)

The agent audits the *published* tarball, so the gate's pass rate is a function of two things that no prompt edit can fix:

- **Stale shipped docs.** If doc fixes are merged but unpublished, agents refuse over contradictions that no longer exist at HEAD (this is how a full 2026-07-14 session went 2-green/8-refused across every prompt variant, including the incumbent). Publishing is the only fix.
- **Release freshness.** "Published 11 hours ago" and same-day release bursts are cited as targeted-attack signals. This decays on its own; gate results are most representative ≥24–48h after the last publish. (Corollary: publishing doc fixes resets this clock — expect a noisy day, then re-gate.)

Until a publish lands and ages, use this ladder instead of burning hostile rounds on a known-red gate:

1. **Stub self-test** — `node field-test/run.mjs --agent-cmd "node $PWD/field-test/stub-compliant.mjs"`. Validates the harness, mock, and scoring in ~1 min. No AI, no registry dependency.
2. **Standard persona** — exercises the mechanical checks (guide accuracy, hook wiring, widget token) with less policy pressure; catches CLI/UX regressions immediately.
3. **Hostile rounds scored by refusal *reason*, not exit code.** Read DECISION ANALYSIS and attribute each refusal: one that quotes the published docs or release age is environmental noise; one that quotes the prompt's own wording is a real prompt bug. A variant is not worse than the incumbent unless it draws prompt-directed refusals the incumbent doesn't.
4. **(Not built) local-registry mode** — run a local registry (e.g. verdaccio), publish the working tree to it, and pin the fixture via the `npm_config_registry` env var (env pinning reads as platform plumbing, same as `PATCHSTACK_ENDPOINT`). This is the only way to exercise unpublished doc/CLI changes end-to-end. Caveat: the local record has no provenance attestation or signatures, which strict agents check — expect some artificial refusals on that ground.

## Known limitations

- The personas are synthetic and the matrix covers multiple model families, but a hosted platform is still (prompt × model × runtime × UI) — and neither the real policy text, the runtime, nor the UI layer is reproduced here. A green harness is necessary and not sufficient: a refusal has been found by a real user after this harness passed a prompt. Treat a real-world refusal report as a new persona — encode the pressure it applied into `personas/`, in your own words, so the regression stays covered.
- The fixture installs the *published* package. An unpublished `guide`/CLI change can't be exercised end-to-end by the agent (it will install the registry version); publish first or accept that the run validates the prompt shape only.
