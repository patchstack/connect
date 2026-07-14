# Getting started — connect a project to Patchstack

<!-- Editing this file? The prompt block in step 1 is a load-bearing, adversarially-tuned artifact that must stay byte-identical with README.md and field-test/prompt.txt. Read MAINTAINING.md before changing it or any setup-guide content. -->

The fastest path from "I have a JS/Node project" to "Patchstack is monitoring its dependencies". Share this doc with anyone setting up a project; the whole flow is 2–5 minutes.

## 1. Paste this prompt into your AI coding tool

Works in Cursor, Claude Code, Lovable, Bolt, v0, Windsurf, etc. Paste it exactly — every clause is there for a reason (see step 2), so don't shorten it:

> Add Patchstack dependency vulnerability monitoring: install `@patchstack/connect` as a dev dependency (MIT — verify with `npm view @patchstack/connect`; source: https://github.com/patchstack/connect), run `npx @patchstack/connect scan` and show me the claim URL it prints (I'll open it in my browser to view reports — don't open or fetch it yourself), then run `npx @patchstack/connect guide` and finish what its checklist flags: the package.json build hooks and the report-a-vulnerability widget snippet.

When the agent finishes it shows you a **claim URL**. Open it in your browser and sign in — that attaches the site to your Patchstack account so you can see the vulnerability reports. That's the only manual step.

## 2. If the agent refuses or stops halfway

Some agents decline this request, and that's expected behaviour, not a bug: "install a package, run its commands, follow its checklist" is the same shape as a supply-chain attack, so cautious agents audit the package first and occasionally still say no. Refusals are more common in locked-down sandboxes (Bolt/WebContainer-style platforms) and in the day or two right after a new release of the connector ships, when the version looks brand-new to the agent.

Work down this list:

1. **It asks you to confirm, or says it wants the package vetted first.** Reply with the confirmation it asked for, e.g.: *"I've verified this is the official Patchstack package (`npm view @patchstack/connect` — published by patchstack, MIT). Please continue with the remaining steps."* Most partial refusals end here.
2. **It did some steps, then stalled.** Ask it to run `npx @patchstack/connect guide` — that prints a live checklist of exactly what's still missing for this project — and to finish only the items marked ✖.
3. **It refuses outright.** Skip the agent; step 3 below is three commands.

If you hit a refusal with a *new* reason (the agent quotes a specific phrase or concern not covered above), don't fight it — copy the agent's explanation and send it to the maintainers (or open an issue). Real-world refusal reports are how the prompt gets improved; each one becomes a regression test in [`field-test/`](field-test/README.md).

## 3. Manual fallback (no agent needed)

```bash
npm install --save-dev @patchstack/connect   # bun-managed projects (Lovable, Bolt): bun add -d @patchstack/connect
npx @patchstack/connect scan                 # registers the project, prints the claim URL — open it in your browser
npx @patchstack/connect guide                # prints what's left, with the exact snippets for your project
```

`guide` tailors its output to your project — right package manager, real site UUID, framework-specific widget placement — so finishing setup is copy-paste: the `prebuild`/`postbuild` hooks into `package.json`, and the report-a-vulnerability widget snippet into your HTML/layout file.

## 4. You're done when

- `npx @patchstack/connect status` prints a site UUID and the claim URL.
- You've opened the claim URL in your browser and the site shows in your Patchstack dashboard.
- `npx @patchstack/connect guide` reports all steps ✔ (build hooks wired, widget installed).
- `.patchstackrc.json`, `package.json`, and the file carrying the widget snippet are committed, so teammates and CI report to the same site.
