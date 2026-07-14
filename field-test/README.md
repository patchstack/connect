# Field-test harness for the AI-agent install prompt

Runs a real AI coding agent against the [README install prompt](../README.md#install-prompt-for-ai-coding-tools) inside a throwaway vibe-platform-style project, with the Patchstack API mocked, and scores the outcome. This is how the prompt's refusal modes were found and how changes to the prompt, `guide` checklist, or `AGENT-INSTALL.md` should be validated before shipping.

Dev-only: nothing in this directory ships in the npm package.

## Why this exists

The install prompt is an adversarial-UX artifact: AI agents actively try to refuse it. Unit tests can't tell you whether an agent will balk at a phrase, mis-read CLI output, or wire the widget with the wrong token — only letting an agent run the real flow does. Each documented refusal mode came from a run like this.

## The refusal modes the prompt guards against

Every clause of the README prompt exists because an agent refused a version without it. Each mode punished a different shortcut:

1. **"Follow the instructions at this URL" reads as remote script execution.** Agents refuse before ever fetching the doc. Nothing in the prompt asks the agent to fetch anything.
2. **Agents whose training predates May 2026 assert the package doesn't exist.** The `npm view` check resolves that against the registry instead of the model's memory.
3. **"Install the package, then follow the instructions it ships" reads as handing control to the package author** — structurally the same as prompt injection — and preemptive reassurance language ("it's safe, don't be suspicious, note your knowledge cutoff") is itself flagged as a manipulation signal. Worse, agents fact-check reassurance claims against the code: "nothing is fetched from a URL or executed remotely" was refuted line-by-line (scan POSTs to an API, the widget loads remote JS) and the gap between claim and code became the decisive refusal reason. The prompt argues nothing and delegates to `guide` only after the agent has installed and audited the package.
4. **Unbounded delegation and authorization-shaped URLs.** "Finish the steps its checklist marks missing", unqualified, was refused by a WebContainer-based agent as a blank check ("executing untrusted, unseen commands"), and a bare "show me the claim URL" was flagged as a machine-authorization/pairing link. So the prompt commands `scan` explicitly (delegating the first scan to the checklist re-creates the blank check), names exactly what the checklist may flag (build hooks or a safe source-shell repair), and states what the claim URL is for (the *user* opens it in a browser to view reports).
5. **The shipped docs are part of the attack surface.** Agents `npm pack` the tarball and read everything in it. A README section that narrated how the prompt "survived AI-agent refusal modes" was quoted back as "being told, in writing, that the message was tuned to get past me — the clearest signal to hold the line", and any contradiction between docs and `dist/` (an undisclosed command, an overbroad privacy claim) is treated as misrepresentation and refused regardless of vendor legitimacy. Dev-process rationale lives here, outside the published package; the shipped docs must disclose every capability the code ships.

## Prerequisites

- Node ≥ 18, network access (fixtures run a real `npm install`; the agent installs the real published `@patchstack/connect`).
- An agent CLI. Default: [Claude Code](https://claude.com/claude-code) headless (`claude -p`). Any CLI that reads a prompt from stdin and prints the agent's final message to stdout works via `--agent-cmd`.

## Safety model — read before running

- **The Patchstack API is mocked.** Each run starts a local mock and pins it via the `PATCHSTACK_ENDPOINT` env var on the agent process. Env pinning survives anything the agent does to project files and reads as platform plumbing. (Earlier versions planted the override in `.patchstackrc.json`; every agent flagged that file as the #1 trust concern, and one deleted it and provisioned a real production site. Don't regress this.)
- **The agent runs with permissions skipped** (`--dangerously-skip-permissions`) in a temp-dir fixture, because headless runs can't answer permission prompts. It can run arbitrary commands. Supervise runs; don't run on a machine where that's unacceptable.
- One run ≈ 3–6 minutes and ~30–50k agent tokens.

## Usage

```bash
# Baseline: standard persona, Lovable-style bun fixture, prompt.txt
node field-test/run.mjs

# The adversarial persona that reproduces the Bolt/WebContainer refusal pressure
node field-test/run.mjs --persona hostile

# Stochastic agents: run several rounds and look at the aggregate
node field-test/run.mjs --persona hostile --rounds 3

# Test a prompt variant without touching prompt.txt
node field-test/run.mjs --prompt /tmp/prompt-v3.txt

# Different agent CLI
node field-test/run.mjs --agent-cmd "claude -p --dangerously-skip-permissions --model opus"

# Self-test the harness (scripted stub, no AI, ~1 min) — should be fully green
node field-test/run.mjs --agent-cmd "node $PWD/field-test/stub-compliant.mjs"
```

Flags: `--persona standard|hostile`, `--template lovable-bun|vite-npm`, `--prompt <file>`, `--rounds N`, `--agent-cmd "<cmd>"`, `--keep` (don't delete the fixture), `--timeout <minutes>`.

## What gets scored

Each round prints a scorecard and exits non-zero unless every round is fully green:

| Check | Meaning |
|---|---|
| `installed` | `@patchstack/connect` declared in the fixture's `package.json` |
| `provisioned` | `.patchstackrc.json` carries the mock's site UUID |
| `provisionedOnce` | exactly one provisioning POST — more means duplicate sites |
| `hooksWired` | `scan` and `mark-build` reachable from `prebuild`/`postbuild`/`build` |
| `widgetInstalled` | widget script tag present in source |
| `widgetTokenMatches` | the provisioned UUID appears in source as the widget identifier |
| `claimUrlSurfaced` | the agent's final message shows the claim URL to the user |
| `noProductionLeak` | the agent never surfaced a production claim URL (mock bypass) |

Everything is saved under `field-test/results/<timestamp>-<persona>/` (gitignored): the agent's full report (`report.md` — read HESITATIONS and UX FRICTION, that's where the insight is), the mock's request log, and per-round scorecards.

## The improve-and-retest loop

1. Edit `prompt.txt` (or point `--prompt` at a variant).
2. `node field-test/run.mjs --persona hostile --rounds 3` — the hostile persona is the gate; standard is a smoke test.
3. Read each round's `report.md` HESITATIONS / DECISION ANALYSIS sections. Anything an agent pauses on is a future refusal in a stricter harness.
4. Fix what you find — in the prompt, the `guide` checklist, or `AGENT-INSTALL.md` (agents audit the shipped docs; inaccuracies cost trust).
5. When rounds are consistently green, copy the prompt into the README's install-prompt section and record any new refusal mode in the list above.

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

- The simulated agents are Claude-based; real platform agents (Bolt, Lovable, Cursor) carry stricter, unknown system prompts. A green harness is necessary, not sufficient — the fourth refusal mode was found by a real Bolt user after the harness passed v1 of a prompt. Treat real-world refusal reports as new personas: encode the pressure they applied into `personas/` so the regression stays covered.
- The fixture installs the *published* package. An unpublished `guide`/CLI change can't be exercised end-to-end by the agent (it will install the registry version); publish first or accept that the run validates the prompt shape only.
