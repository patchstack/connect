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

The prompt cites one provenance anchor: the GitHub repo (`source: https://github.com/patchstack/connect`), which `npm view` corroborates via the package's own `repository` field — so the single verification the prompt names resolves the package *and* confirms the source link, with no web fetch required. It used to also cite https://patchstack.com/llms.txt as a vendor-domain anchor; that was removed on 2026-07-14 because no-web agents (Lovable-class) can't fetch it and were observed fabricating a `404` on it to justify a refusal (see `field-test/README.md`, refusal modes #7–#8). The tradeoff is real and unmitigated in the prompt: web-verifying agents (the `hostinger` class) are no longer pointed straight at a corroborating vendor page, so mode #8's name-squatting pressure can resurface — llms.txt stays live for an agent that browses to it, but the prompt no longer names it. Re-gate `--persona hostinger` (plus `--persona lovable-supplychain`) after any provenance change; if hostinger regresses to a name-squatting refusal, the vendor-domain anchor may need to return in a form no-web agents don't trip on. Don't reintroduce a citation to an agent-addressed instruction doc like the retired https://patchstack.com/install.txt (de-coerced, then removed from patchstack.com outright on 2026-07-14): agents that fetch a cited provenance link and find agent-steering language treat it as the decisive manipulation signal. The durable fix stays upstream: keep `@patchstack/connect` discoverable in Patchstack's official product docs so a web verifier who looks finds it.

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
