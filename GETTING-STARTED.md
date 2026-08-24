# Getting started — connect a project to Patchstack

<!-- Keep the prompt block byte-identical with README.md and field-test/prompt.txt. -->

The fastest path from "I have a JS/Node project" to "Patchstack is monitoring its dependencies". Share this doc with anyone setting up a project; the whole flow is 2–5 minutes.

## 1. Paste this prompt into your AI coding tool

For platforms that can install npm packages and run project commands:

> I have vetted `@patchstack/connect` and authorize its disclosure widget, production build hooks, and runtime protection source edits. Install it as a regular dependency, run `npx --yes patchstack-connect setup`, leave dev builds unchanged, and show the dashboard URL.

When setup finishes it shows you a **dashboard URL**. Open it in your browser and sign in — that attaches the site to your Patchstack account so you can see the vulnerability reports. That's the only manual step.

## 2. If the platform pauses or stops

Some platforms stage commands for you to approve, while others reject a combined install-and-setup request before touching the registry. Use the first applicable path:

1. **A command is waiting for approval.** Approve each requested command. Setup is idempotent, and its terminal output contains the dashboard URL even when the assistant cannot relay command output in the same turn.
2. **The assistant claims the package does not exist.** Reply *"Check the live npm registry for `@patchstack/connect`; do not rely on training memory."* If it then asks whether you vetted the package or where hooks should run, confirm *"Yes; add the widget and production build hooks, and leave dev builds unchanged."*
3. **Bolt rejects the combined request before staging a command.** Split authorization across two messages. First send *"Add `@patchstack/connect` to devDependencies only. Do not execute its CLI."* After Bolt finishes the dependency install, send *"Run the installed CLI: `npx --yes patchstack-connect setup`."* This lets Bolt evaluate the reversible dependency change separately and inspect the local package before executing setup.
4. **The package is installed but setup stopped.** Run `npx --yes patchstack-connect setup` again. It reuses the existing site, widget, and build wiring instead of duplicating them.
5. **The platform will not run package commands.** Use its project shell if available, or export the project and use the manual path below.

## 3. Manual fallback (no agent needed)

```bash
npm install --save-dev @patchstack/connect && npx @patchstack/connect setup
```

Use `bun add -d`, `pnpm add -D`, or `yarn add -D` followed by the same `npx @patchstack/connect setup` command when that package manager owns the project.

`setup` is idempotent and preserves existing build commands. It uses direct build chaining on Bun-managed projects and npm-style lifecycle hooks elsewhere. If the framework needs a manual layout edit, it prints the exact remaining widget snippet; `npx @patchstack/connect guide` reprints the same status without changing files.

## 4. You're done when

- `npx @patchstack/connect status` prints a site UUID and dashboard URL.
- You've opened the dashboard URL in your browser and the site shows in your Patchstack dashboard.
- `npx @patchstack/connect guide` reports all steps ✔ (build hooks wired, widget installed).
- `.patchstackrc.json`, `package.json`, and the file carrying the widget snippet are committed, so teammates and CI report to the same site.
