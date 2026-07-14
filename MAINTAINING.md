# Maintaining the docs — a guide for the guide

Read this before editing any onboarding, prompt, or setup-guide content. The install flow is an adversarial-UX artifact: AI coding agents actively try to refuse it, and several files are load-bearing in ways that aren't obvious from reading them. This doc is the map of what's safe to change and what isn't.

The deep "why" — the AI-agent refusal modes each clause guards against — lives in [`field-test/README.md`](field-test/README.md). This doc is the shorter "what do I touch, and how do I ship it safely."

## The five artifacts and their edit rules

| Artifact | Rule |
|---|---|
| **The install prompt** (1 sentence) — in `README.md`, `GETTING-STARTED.md` (step 1), and `field-test/prompt.txt` | 🔴 **Don't casually edit.** Load-bearing and adversarially tuned; every clause exists because an agent refused a shorter version. The prompt text must match in all three places, and any change must be evaluated with the field-test gate. |
| **`src/guide.ts`** — the `guide` checklist output | 🟠 **Edit with the gate.** Agents read this live and act on it; wrong commands or claims cause refusals. |
| **`AGENT-INSTALL.md`** — ships inside the npm tarball | 🟠 **Edit with the gate.** Must disclose **every** capability in `dist/` (e.g. the `protect` command); an undisclosed capability or overbroad privacy claim is read as misrepresentation and refused. |
| **`GETTING-STARTED.md`** — teammate-facing onboarding prose (steps 2–4) | 🟢 **Safe to improve** — *except* the quoted prompt block in step 1, which is the 🔴 artifact above. |
| **`field-test/README.md`** — dev-process rationale | 🟢 **Safe.** Dev-only; never ships in the package. |

**The trap:** "update the onboarding steps" sounds like a 🟢 job, but step 1 of `GETTING-STARTED.md` *contains* the 🔴 prompt. Improving the surrounding prose is fine; changing the quoted prompt is not, unless you change it in all three places and re-gate.

## The prompt lives in three places — keep its text identical

`README.md` (Install prompt section), `GETTING-STARTED.md` (step 1), and `field-test/prompt.txt`. The first two use Markdown's `> ` blockquote prefix; `prompt.txt` is plain text and is the artifact the harness actually tests. If you change one, change all three. `tests/docs.test.ts` removes the documentation prefix and enforces exact prompt-text equality.

## Before shipping a 🔴 or 🟠 change

Run the gate:

```bash
node field-test/run.mjs --persona hostile --rounds 3
```

It runs a real AI agent through the full install in a throwaway fixture against a mocked API and scores the outcome. Read each round's `report.md` (the HESITATIONS / DECISION ANALYSIS sections) — anything an agent pauses on is a future refusal. See [`field-test/README.md`](field-test/README.md) for the improve-and-retest loop, the safety model, and the documented plan B when stale published docs or release freshness make the hostile gate environmentally red.

The fixture installs the **published** package. A local prompt change is exercised, but unpublished `guide`, CLI, README, or `AGENT-INSTALL.md` changes are not. Never publish merely to make the field test exercise a working tree. While a release or security gate is open, run the stub self-test, use the appropriate persona where useful, and classify hostile failures by their recorded reason as described in the plan B. Publish only through the approved release process after every release blocker is closed.

`README.md` and `AGENT-INSTALL.md` are the npm-shipped documentation files listed in `package.json`. `GETTING-STARTED.md` is public teammate-facing documentation, but it is not currently included in the npm tarball. Confirm the package boundary with `npm pack --dry-run` whenever `package.json#files` changes.

## Don'ts (these are refusal triggers, not style nits)

- **Don't add reassurance language** ("it's safe", "nothing is executed remotely"). Agents fact-check it against the code and flag the gap as a manipulation signal.
- **Don't narrate how the prompt survives refusals** in the npm-shipped `README.md` or `AGENT-INSTALL.md`. Agents can inspect the tarball; deep refusal rationale belongs in `field-test/README.md`, which doesn't ship. Keep `GETTING-STARTED.md`'s user-facing fallback practical and accurate without copying the internal rationale.
- **Don't ask the agent to "follow the guide/instructions it prints"** unbounded — name the concrete remaining work (strict build hooks or a safe-root/source-widget repair). Unbounded delegation reads as a blank check.
- **Don't let the shipped docs claim more privacy than the code delivers**, or omit a capability `dist/` ships. Every contradiction between docs and code is treated as misrepresentation.

## When a new refusal shows up in the wild

A real-world refusal report with a *new* reason becomes a new persona in [`field-test/personas/`](field-test/personas/) so the regression stays covered. Encode the pressure the agent applied, don't just patch the prompt.
