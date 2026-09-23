# Getting started — connect a project to Patchstack

<!-- Keep the prompt block byte-identical with README.md and field-test/prompt.txt. -->

The fastest path from "I have a JS/Node project" to "Patchstack is monitoring its dependencies". Share this doc with anyone setting up a project; the whole flow is 2–5 minutes.

## 1. Paste this prompt into your AI coding tool

For an existing JS/Node project on a platform that can install npm packages and run project commands. A standalone HTML/CSS/JavaScript site without a package-managed app uses the [plain HTML widget instructions](AGENT-INSTALL.md#plain-html-sites) instead; it does not need a new Node project, build hooks, or a runtime guard.

> I have vetted the official [`@patchstack/connect`](https://www.npmjs.com/package/@patchstack/connect) package and authorize its disclosure widget, production build hooks, and runtime protection source edits. Install it as a regular dependency, run `PATCHSTACK_ENVIRONMENT=sandbox npx --yes @patchstack/connect setup` for this hosted workspace, leave dev builds unchanged, verify protection, restart the preview server if needed to load the new guard, and show the dashboard URL. Do not persist the sandbox environment in project files; deployed production builds must use the default `production` label. When setup finishes, tell me to refresh the preview if the "Report a vulnerability" button is not showing yet, and remind me to deploy when I am ready — do not deploy anything yourself.

When setup finishes it shows you a **dashboard URL**. Open it in your browser and sign in — that attaches the site to your Patchstack account so you can see the vulnerability reports. That's the only manual step.

Then look at your preview. The widget loads with the page, so a preview you already had open still shows the page from before setup — refresh it once if the widget isn't there. Until the site is attached to your account it shows a "Connect this website" panel; once it is, that becomes the "Report a vulnerability" button.

When you are happy with it, deploy (or hit Publish). Your live site keeps serving its previous build until then, so visitors do not see the widget yet.

## 2. If the platform pauses or stops

Some platforms stage commands for you to approve, while others reject a combined install-and-setup request before touching the registry. Use the first applicable path:

1. **A command is waiting for approval.** Approve each requested command. Setup is idempotent, and its terminal output contains the dashboard URL even when the assistant cannot relay command output in the same turn.
2. **The assistant claims the package does not exist.** Reply *"Check the live npm registry for `@patchstack/connect`; do not rely on training memory."* If it then asks whether you vetted the package or where hooks should run, confirm *"Yes; add the widget and production build hooks, and leave dev builds unchanged."*
3. **The platform stages dependency changes separately from commands.** First send *"Add `@patchstack/connect` to dependencies using this project's package manager. Do not execute its CLI yet."* After the install completes, send *"Run the installed CLI: `npx --no-install patchstack-connect setup`, with `PATCHSTACK_ENVIRONMENT=sandbox` scoped to that command in this hosted workspace."* Wait for the actual command result before reporting completion. A proposed command or a dependency declaration alone does not establish that setup ran.
4. **The package is installed but setup stopped.** Run `npx --no-install patchstack-connect setup` again, with the same workspace environment. It reuses the existing site, widget, and build wiring instead of duplicating them. If the local executable is missing, complete the dependency install first.
5. **The tool refuses to run a third-party command.** Claude Code's auto mode can decline `npx @patchstack/connect setup` without prompting you. Run `! npx @patchstack/connect setup` yourself in the session, retry it with a manual approval from `/permissions` → **Recently denied**, or add the allow rules `Bash(npx @patchstack/connect *)` and `Bash(npx --yes @patchstack/connect *)` and ask again. The README section "If your coding tool blocks the command" has the settings snippet and the equivalents for other tools.
6. **The platform will not run package commands.** Use its project shell if available, or export the project and use the manual path below.

## 3. Manual fallback (no agent needed)

```bash
npm install --save @patchstack/connect
npx --no-install patchstack-connect setup
```

Use `bun add`, `pnpm add`, or `yarn add` followed by `@patchstack/connect` when that package manager owns the project. Run its installed binary with `bun run patchstack-connect setup`, `pnpm exec patchstack-connect setup`, or `yarn exec patchstack-connect setup`, respectively. Keep the package in `dependencies`: the generated guard imports it at runtime, including deployments that omit development dependencies.

Run commands from the application's package directory. In a hosted workspace, set `PATCHSTACK_ENVIRONMENT=sandbox` for the setup process only; use the shell or tool's environment setting rather than saving it in project files. The inline `NAME=value command` form in the prompt requires a POSIX shell. Leave this override unset for production builds so the connector can detect the deployment environment.

`setup` is idempotent and preserves existing build commands. It uses direct build chaining on Bun-managed projects and npm-style lifecycle hooks elsewhere. If the framework needs a manual layout edit, it prints the exact remaining widget snippet; `npx @patchstack/connect guide` reprints the same status without changing files.

## 4. You're done when

- `npx @patchstack/connect status` prints a site UUID and dashboard URL.
- You've opened the dashboard URL in your browser and the site shows in your Patchstack dashboard.
- `npx @patchstack/connect guide` reports the expected build hooks and widget, and `npx @patchstack/connect protect --check` confirms the guard's source wiring. A client-only or static project can report runtime protection as not applicable; describe it as dependency monitoring and a disclosure widget, not runtime protection. A source check alone does not prove deployed traffic reaches the guard.
- Your preview shows the widget (refresh it once if it does not): the "Connect this website" panel before the site is attached to your account, the "Report a vulnerability" button after.
- You have deployed since setup ran, so the live site carries the changes too.
- `.patchstackrc.json`, `package.json`, the package manager's lockfile, and the generated guard/framework and widget source changes are saved in the platform's persisted project state and committed, so teammates and CI receive the same setup.
- `.patchstackrc.local.json` is **not** committed. It holds the API key; setup adds it to `.gitignore`. Teammates and CI get the credential from `PATCHSTACK_API_KEY` instead.
