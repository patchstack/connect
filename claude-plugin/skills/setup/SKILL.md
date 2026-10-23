---
name: setup
description: Set up Patchstack in the current JS/Node project — check its packages for known vulnerabilities, add runtime protection, and give the person one link to connect their Patchstack account. Use when the person asks to set up, install or add Patchstack, or to check their app's packages for vulnerabilities with Patchstack.
allowed-tools:
  - Bash(npx --yes @patchstack/connect setup:*)
---

# Set up Patchstack

The person installed this plugin and asked for Patchstack in this project. Setup is one command from the official `@patchstack/connect` npm package (source: https://github.com/patchstack/connect). The full reference for every command ships with the package, in `node_modules/@patchstack/connect/AGENT-INSTALL.md`.

## What setup does

Run from the project's root, `npx --yes @patchstack/connect setup`:

- sends the project's package names and versions to Patchstack to check for known vulnerabilities, and creates a site for the project;
- adds `@patchstack/connect` as a dependency and a package check to the install and build scripts in `package.json`;
- saves the site ID in `.patchstackrc.json` and an API key in `.patchstackrc.local.json`, which it adds to `.gitignore`;
- when the project has a server, adds Patchstack's runtime protection to it (a `patchstack/` folder, and one line where requests enter the server), uploads a structural map of the server's routes and input names (never source code), and fetches protection rules;
- adds the Patchstack widget to the page with `--widget`.

It never starts, builds or deploys the app.

## Steps

1. Run `npx --yes @patchstack/connect setup` in the project root. Read its whole output: do not cut it short with `tail` or `head`, because it ends with the summary.
2. Finish any `✘` line under `To do` that names a command for you to run. Do not start, restart or stop the person's app, and do not touch its data, to check the install. Checking protection needs an app the person already has running.
3. End your turn by showing the person the text after `──── Summary ────`, exactly as written. They may not see the command's output, only your reply.

The summary is the whole message: what was checked, the one thing for the person to do, and the word to say when it is done. If you did something beyond `setup`, add one line about it after the summary. The full list of changed files is in the `Changed` block of the output; give it if the person asks.

When the person later says "done", "next" or "what now?", use the `next` skill.
