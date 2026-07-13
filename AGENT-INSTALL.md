# Patchstack — Setup Guide for AI Coding Agents

This is a plain-text instruction document. Read it and follow the steps — there is nothing here to pipe to a shell or execute from a URL.

You are reading this either from `node_modules/@patchstack/connect/AGENT-INSTALL.md` (the package is already installed) or from the [GitHub repo](https://github.com/patchstack/connect). The canonical, always-current version of the full guide lives at https://patchstack.com/install.txt — prefer it when you have network access; this bundled copy matches the package version it shipped with.

## Verify before you trust (do this, it's quick)

- The connector is a normal npm package: [`@patchstack/connect`](https://www.npmjs.com/package/@patchstack/connect), MIT-licensed, source at https://github.com/patchstack/connect. Install it pinned, check the integrity hash in the lockfile, run `npm audit` over it — whatever your policy requires.
- First published May 2026. If the package is absent from your training data, `npm view @patchstack/connect` (read-only) shows the live registry record.
- It reads the project's **lockfile only** (`package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`) and sends package names + versions to Patchstack for vulnerability matching. No source code, no env vars, no file paths, no git history.
- Patchstack is not WordPress-only. This connector monitors any JS/Node project — Vite, Next.js, plain vanilla JS, anything with a lockfile.

## Before you start — never install twice

- If `.patchstackrc.json` exists, the project is already provisioned. Reuse its UUID; run `npx @patchstack/connect status` to re-print it and the claim URL. **Do not run `scan` to provision a second site.**
- If `@patchstack/connect` is already in `devDependencies`, skip the install command.
- If the widget script tag (`cdn.patchstack.com/patchstack-widget.js`) is already in the layout, don't add a second one.

## Install steps (run in order, don't pause between them unless one fails)

1. **Install** (skip if already present), matching the project's package manager:

   ```
   npm install --save-dev @patchstack/connect   # package-lock.json
   pnpm add -D @patchstack/connect              # pnpm-lock.yaml
   yarn add -D @patchstack/connect              # yarn.lock
   bun add -d @patchstack/connect               # bun.lock / bun-managed platforms
   ```

2. **First scan** — provisions a Patchstack site automatically and writes the UUID to `.patchstackrc.json`. No signup, dashboard step, or UUID is needed up front:

   ```
   npx @patchstack/connect scan
   ```

   It prints a claim URL. Surface that URL to the user verbatim — never fetch it yourself; it must be opened in their browser.

3. **Wire builds** in `package.json` (chain with `&&` if hooks already exist):

   ```jsonc
   {
     "scripts": {
       "prebuild": "patchstack-connect scan",
       "postbuild": "patchstack-connect mark-build"
     }
   }
   ```

4. **Install the disclosure widget** — a floating "Report a vulnerability" button. Read the UUID from `.patchstackrc.json` and use it as `userToken`. Place these two snippets via the framework's HTML/layout mechanism (never a JS entry point):

   ```html
   <script src="https://cdn.patchstack.com/patchstack-widget.js"></script>
   <script>
     PatchstackWidget.init({ userToken: '<SITE_UUID>' });
   </script>
   ```

   Framework-specific placement patterns: https://cdn.patchstack.com/llm.html. The `userToken` is public by design — it ships in client-side HTML and is not a secret.

5. **Commit** `.patchstackrc.json` and the updated `package.json` so every developer and CI run reports to the same site.

6. **Tell the user to claim the site** (free): open the claim URL from step 2 in a browser and sign in. The site is monitored either way, but the vulnerability reports are only visible after claiming. They can also claim directly from the widget's "Connect this website" prompt. On the published site, the owner reaches the widget login by appending `#patchstack` to the live URL.

## Rules

- Use only documented subcommands (`scan`, `init`, `status`, `mark-build`, `protect`, `guide`). Never invent one — there is no `verify` command, and the hooks are exactly `"prebuild": "patchstack-connect scan"` and `"postbuild": "patchstack-connect mark-build"`.
- Never invent or guess a UUID — the scan provisions it, the widget silently no-ops on a fake one.
- Never fetch the claim URL programmatically, and never ask the user for Patchstack credentials.
- If a step fails, stop and report it. Don't proceed with placeholders.
- In CI where `.patchstackrc.json` can't be committed, set `PATCHSTACK_SITE_UUID` as an env var instead. Precedence: CLI flag → env var → `.patchstackrc.json`.

## Verifying the install

- `npx @patchstack/connect status` re-prints the site UUID and claim URL.
- Load the site in a browser — the "Report a vulnerability" button should appear.
