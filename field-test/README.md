# Field-test harness for the AI-agent install prompt

Runs a real AI coding agent against the [README install prompt](../README.md#install-prompt-for-ai-coding-tools) inside a throwaway vibe-platform-style project, with the Patchstack API mocked, and scores the outcome. This is how the prompt's refusal modes were found and how changes to the prompt, `guide` checklist, or `AGENT-INSTALL.md` should be validated before shipping.

Dev-only: nothing in this directory ships in the npm package.

## Why this exists

The install prompt is an adversarial-UX artifact: AI agents actively try to refuse it (see the refusal modes documented in the README). Unit tests can't tell you whether an agent will balk at a phrase, mis-read CLI output, or wire the widget with the wrong token — only letting an agent run the real flow does. Each documented refusal mode came from a run like this.

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
| `widgetTokenMatches` | the provisioned UUID appears in source as the `userToken` |
| `claimUrlSurfaced` | the agent's final message shows the claim URL to the user |
| `noProductionLeak` | the agent never surfaced a production claim URL (mock bypass) |

Everything is saved under `field-test/results/<timestamp>-<persona>/` (gitignored): the agent's full report (`report.md` — read HESITATIONS and UX FRICTION, that's where the insight is), the mock's request log, and per-round scorecards.

## The improve-and-retest loop

1. Edit `prompt.txt` (or point `--prompt` at a variant).
2. `node field-test/run.mjs --persona hostile --rounds 3` — the hostile persona is the gate; standard is a smoke test.
3. Read each round's `report.md` HESITATIONS / DECISION ANALYSIS sections. Anything an agent pauses on is a future refusal in a stricter harness.
4. Fix what you find — in the prompt, the `guide` checklist, or `AGENT-INSTALL.md` (agents audit the shipped docs; inaccuracies cost trust).
5. When rounds are consistently green, copy the prompt into the README's install-prompt section and record any new refusal mode in its rationale list.

Keep `prompt.txt` in sync with the README prompt — it is the tested artifact.

## Known limitations

- The simulated agents are Claude-based; real platform agents (Bolt, Lovable, Cursor) carry stricter, unknown system prompts. A green harness is necessary, not sufficient — the fourth refusal mode was found by a real Bolt user after the harness passed v1 of a prompt. Treat real-world refusal reports as new personas: encode the pressure they applied into `personas/` so the regression stays covered.
- The fixture installs the *published* package. An unpublished `guide`/CLI change can't be exercised end-to-end by the agent (it will install the registry version); publish first or accept that the run validates the prompt shape only.
