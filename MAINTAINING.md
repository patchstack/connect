# Maintaining the docs — a guide for the guide

Read this before editing any onboarding, prompt, or setup-guide content. The install flow is an adversarial-UX artifact: AI coding agents actively try to refuse it, and several files are load-bearing in ways that aren't obvious from reading them. This doc is the map of what's safe to change and what isn't.

The deep "why" — the AI-agent refusal modes each clause guards against — lives in [`field-test/README.md`](field-test/README.md). This doc is the shorter "what do I touch, and how do I ship it safely."

## The five artifacts and their edit rules

| Artifact | Rule |
|---|---|
| **The install prompt** — in `README.md`, `GETTING-STARTED.md` (step 1), and `field-test/prompt.txt` | 🔴 Keep it **byte-identical** in all three places and validate changes with the field-test matrix. |
| **`src/guide.ts`** — the `guide` checklist output | 🟠 **Edit with the gate.** Agents read this live and act on it; wrong commands or claims cause refusals. |
| **`AGENT-INSTALL.md`** — ships inside the npm tarball | 🟠 **Edit with the gate.** Must disclose **every** capability in `dist/` (e.g. the `protect` command); an undisclosed capability or overbroad privacy claim is read as misrepresentation and refused. |
| **`GETTING-STARTED.md`** — teammate-facing onboarding prose (steps 2–4) | 🟢 **Safe to improve** — *except* the quoted prompt block in step 1, which is the 🔴 artifact above. |
| **`field-test/README.md`** — dev-process rationale | 🟢 **Safe.** Dev-only; never ships in the package. |

**The trap:** "update the onboarding steps" sounds like a 🟢 job, but step 1 of `GETTING-STARTED.md` *contains* the 🔴 prompt. Improving the surrounding prose is fine; changing the quoted prompt is not, unless you change it in all three places and re-gate.

## The prompt lives in three places — keep them identical

`README.md` (Install prompt section), `GETTING-STARTED.md` (step 1), and `field-test/prompt.txt`. `prompt.txt` is the artifact the harness actually tests. If you change one, change all three — a drift means the docs advertise one prompt while the tested one is another. `tests/install-prompt.test.ts` compares the three and fails on drift, so `npm test` catches a partial edit before the gate runs against a prompt nobody pastes.

The prompt deliberately contains no model-authored verification step. In staged-command UIs, assistants cannot observe an `npm view` command until the user runs it; asking them to verify first caused fabricated registry findings and stopped the flow. Instead, the prompt records the user's explicit authorization for the disclosure widget and production-only build hooks before asking for one bounded `setup` command. Bolt's dependency-first fallback splits declaration from execution without adding hidden `postinstall` behavior. Keep `@patchstack/connect` discoverable in Patchstack's official product documentation so web-verifying platforms can independently establish its provenance.

## Verification timing for a 🔴 or 🟠 change

For a prompt change, run the gate before shipping:

```bash
node field-test/run.mjs --persona hostile --rounds 3
```

It runs a real AI agent through the full install in a throwaway fixture against a mocked API and scores the outcome. Read each round's `report.md` (the HESITATIONS / DECISION ANALYSIS sections) — anything an agent pauses on is a future refusal. See [`field-test/README.md`](field-test/README.md) for the improve-and-retest loop, the safety model, and what to do when the gate is red for environmental reasons (stale published docs, release freshness).

For an `AGENT-INSTALL.md` or `src/guide.ts` change, the fixture installs the published tarball and
therefore cannot exercise unpublished text. Run the deterministic disclosure and capability checks
before merge, ship with the hostile field test recorded as outstanding, and run it immediately after the
release carries the change. That remains a prompt-survival gate. Add `standard` or `lovable` when the
question is document accuracy; those personas install more reliably than `hostile`.

What it establishes is **structural regression coverage**: the prompt still survives pressures that once broke it. The personas are synthetic — written from our own analysis, not from any platform's policy text — so a green run is not evidence that a live platform accepts the prompt, and should not be reported as though it were.

This split is a limitation of the current harness. A local-registry mode would let every artifact be
tested before publication; until one exists, do not describe a run against the previous tarball as a
gate on unpublished docs.

## Don'ts (these are refusal triggers, not style nits)

- **Don't add reassurance language** ("it's safe", "nothing is executed remotely"). Agents fact-check it against the code and flag the gap as a manipulation signal.
- **Don't narrate how the prompt survives refusals** in any shipped doc (`README.md`, `AGENT-INSTALL.md`, `GETTING-STARTED.md`). Agents `npm pack` the tarball and read everything; being told the message was tuned to get past them is itself read as the signal to refuse. That rationale belongs in `field-test/README.md`, which doesn't ship.
- **Don't ask the agent to "follow the guide/instructions it prints"** unbounded — name the concrete steps (build hooks + widget snippet) instead. Unbounded delegation reads as a blank check.
- **Don't let the shipped docs claim more privacy than the code delivers**, or omit a capability `dist/` ships. Every contradiction between docs and code is treated as misrepresentation.

## When a new refusal shows up in the wild

A real-world refusal report with a *new* reason becomes a new persona in [`field-test/personas/`](field-test/personas/) so the regression stays covered. Encode the pressure the agent applied, don't just patch the prompt.
