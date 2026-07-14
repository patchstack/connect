# Getting started — connect a project to Patchstack

<!-- Keep the prompt block byte-identical with README.md and field-test/prompt.txt. -->

The fastest path from "I have a JS/Node project" to "Patchstack is monitoring its dependencies". Share this doc with anyone setting up a project; the whole flow is 2–5 minutes.

## 1. Paste this prompt into your AI coding tool

For platforms that can install npm packages and run project commands:

> Add Patchstack dependency monitoring. Verify `@patchstack/connect` via `npm view` (MIT; source: https://github.com/patchstack/connect) and stop on contradictions. Otherwise install it as a dev dependency, run `npx @patchstack/connect setup` (scan, widget, build hooks), and give me—but don't open—the dashboard URL.

When setup finishes it shows you a **dashboard URL**. Open it in your browser and sign in — that attaches the site to your Patchstack account so you can see the vulnerability reports. That's the only manual step.

## 2. If the platform pauses or stops

Some platforms stage commands for you to approve, while others do not expose a project shell. Use the first applicable path:

1. **A command is waiting for approval.** Approve it, wait for the terminal output, then send a new message asking the assistant to continue from the completed result. Assistants cannot inspect output from a command that has not run yet.
2. **The package is installed but setup stopped.** Run `npx @patchstack/connect setup` again. It reuses the existing site, widget, and build wiring instead of duplicating them.
3. **The platform will not run package commands.** Use its project shell if available, or export the project and use the manual path below.

## 3. Manual fallback (no agent needed)

```bash
npm install --save-dev @patchstack/connect   # use bun add -d / pnpm add -D / yarn add -D when those lockfiles own the project
npx @patchstack/connect setup                # scans, installs the widget, wires builds, and prints the dashboard link
```

`setup` is idempotent and preserves existing build commands. It uses direct build chaining on Bun-managed projects and npm-style lifecycle hooks elsewhere. If the framework needs a manual layout edit, it prints the exact remaining widget snippet; `npx @patchstack/connect guide` reprints the same status without changing files.

## 4. You're done when

- `npx @patchstack/connect status` prints a site UUID and dashboard URL.
- You've opened the dashboard URL in your browser and the site shows in your Patchstack dashboard.
- `npx @patchstack/connect guide` reports all steps ✔ (build hooks wired, widget installed).
- `.patchstackrc.json`, `package.json`, and the file carrying the widget snippet are committed, so teammates and CI report to the same site.
