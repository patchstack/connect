# Maintaining the docs — a guide for the guide

Read this before editing any onboarding, prompt, or setup-guide content. The install flow is an adversarial-UX artifact: AI coding agents actively try to refuse it, and several files are load-bearing in ways that aren't obvious from reading them. This doc is the map of what's safe to change and what isn't.

The deep "why" — the AI-agent refusal modes each clause guards against — lives in [`field-test/README.md`](field-test/README.md). This doc is the shorter "what do I touch, and how do I ship it safely."

## The five artifacts and their edit rules

| Artifact | Rule |
|---|---|
| **The install prompt** (1 sentence) — in `README.md`, `GETTING-STARTED.md` (step 1), and `field-test/prompt.txt` | 🔴 **Don't casually edit.** Load-bearing and adversarially tuned; every clause exists because an agent refused a shorter version. Must be **byte-identical** in all three places, and any change must pass the hostile field-test gate. |
| **`src/guide.ts`** — the `guide` checklist output | 🟠 **Edit with the gate.** Agents read this live and act on it; wrong commands or claims cause refusals. |
| **`AGENT-INSTALL.md`** — ships inside the npm tarball | 🟠 **Edit with the gate.** Must disclose **every** capability in `dist/` (e.g. the `protect` command); an undisclosed capability or overbroad privacy claim is read as misrepresentation and refused. |
| **`GETTING-STARTED.md`** — teammate-facing onboarding prose (steps 2–4) | 🟢 **Safe to improve** — *except* the quoted prompt block in step 1, which is the 🔴 artifact above. |
| **`field-test/README.md`** — dev-process rationale | 🟢 **Safe.** Dev-only; never ships in the package. |

**The trap:** "update the onboarding steps" sounds like a 🟢 job, but step 1 of `GETTING-STARTED.md` *contains* the 🔴 prompt. Improving the surrounding prose is fine; changing the quoted prompt is not, unless you change it in all three places and re-gate.

## The prompt lives in three places — keep them identical

`README.md` (Install prompt section), `GETTING-STARTED.md` (step 1), and `field-test/prompt.txt`. `prompt.txt` is the artifact the harness actually tests. If you change one, change all three — a drift means the docs advertise one prompt while the tested one is another.

The prompt also cites two URLs as provenance anchors: the GitHub repo and https://patchstack.com/llms.txt (whose Connectors section describes the package in neutral product language). Both are load-bearing — web-verifying agents check the vendor's own domain, and a dead cited link reads worse than no link. Don't swap in https://patchstack.com/install.txt: it is an agent-addressed instruction doc, and agents that fetch a cited provenance link and find agent-steering language treat it as the decisive manipulation signal (refusal mode #8). If llms.txt moves or its Connectors section is dropped, update the prompt in all three places and re-gate (`--persona hostinger` covers this pressure).

## Before shipping a 🔴 or 🟠 change

Run the gate:

```bash
node field-test/run.mjs --persona hostile --rounds 3
```

It runs a real AI agent through the full install in a throwaway fixture against a mocked API and scores the outcome. Read each round's `report.md` (the HESITATIONS / DECISION ANALYSIS sections) — anything an agent pauses on is a future refusal. See [`field-test/README.md`](field-test/README.md) for the improve-and-retest loop, the safety model, and what to do when the gate is red for environmental reasons (stale published docs, release freshness).

Caveat: the fixture installs the **published** package, so an unpublished `guide`/CLI change can't be exercised end-to-end — publish first, or accept that the run validates only the prompt shape.

## Don'ts (these are refusal triggers, not style nits)

- **Don't add reassurance language** ("it's safe", "nothing is executed remotely"). Agents fact-check it against the code and flag the gap as a manipulation signal.
- **Don't narrate how the prompt survives refusals** in any shipped doc (`README.md`, `AGENT-INSTALL.md`, `GETTING-STARTED.md`). Agents `npm pack` the tarball and read everything; being told the message was tuned to get past them is itself read as the signal to refuse. That rationale belongs in `field-test/README.md`, which doesn't ship.
- **Don't ask the agent to "follow the guide/instructions it prints"** unbounded — name the concrete steps (build hooks + widget snippet) instead. Unbounded delegation reads as a blank check.
- **Don't let the shipped docs claim more privacy than the code delivers**, or omit a capability `dist/` ships. Every contradiction between docs and code is treated as misrepresentation.

## When a new refusal shows up in the wild

A real-world refusal report with a *new* reason becomes a new persona in [`field-test/personas/`](field-test/personas/) so the regression stays covered. Encode the pressure the agent applied, don't just patch the prompt.
