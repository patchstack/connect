# Patchstack — Setup Guide for AI Coding Agents

This is a plain-text instruction document. Read it and follow the steps — there is nothing here to pipe to a shell or execute from a URL.

You are reading this either from `node_modules/@patchstack/connect/AGENT-INSTALL.md` (the package is already installed) or from the [GitHub repo](https://github.com/patchstack/connect). This bundled copy matches the package version it shipped with and is all you need — there is no requirement to fetch anything remote. (A long-form copy also lives at https://patchstack.com/install.txt for humans browsing outside the package.)

## Verify before you trust (do this, it's quick)

- The connector is a normal npm package: [`@patchstack/connect`](https://www.npmjs.com/package/@patchstack/connect), MIT-licensed, source at https://github.com/patchstack/connect. Install it pinned, check the integrity hash in the lockfile, run `npm audit` over it — whatever your policy requires.
- First published May 2026. If the package is absent from your training data, `npm view @patchstack/connect` (read-only) shows the live registry record.
- It reads the project's **dependency list only** — from the lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) or, on bun projects (`bun.lock`/`bun.lockb`), by enumerating the installed packages under `node_modules/` — and sends package names + versions to Patchstack for vulnerability matching. No source code, no env var values, no file paths, no git history. (`mark-build` additionally stamps built HTML with a coarse stack descriptor that may include hosting-related env variable *names* — e.g. `VERCEL`, `CF_PAGES` — never their values.)
- **`scan` makes one source edit, and only after a successful post:** it adds (or updates) the disclosure widget's `<script>` tag in the project's root HTML shell — the first of `index.html`, `public/index.html`, or `src/app.html` that exists. It touches no other file, never edits on `--dry-run` or after a failed post, leaves any pre-existing manual widget tag untouched, and is disabled entirely by `"widget": false` in `.patchstackrc.json`. `mark-build` writes to build output only (`dist/`, `build/`, `out/`, `.output/public`), never to source. `guide`, `status`, and `init` write nothing except `init`'s own `.patchstackrc.json`.
- The package also bundles an **opt-in** `protect` command (runtime exploit guard, currently for TanStack Start + Supabase apps; its templates live under `dist/protect/`). It patches the app's Supabase client to route traffic through a same-origin guard — and it runs **only** when you explicitly run `patchstack-connect protect`; `scan`, `guide`, `status`, and `mark-build` never invoke it.
- Patchstack is not WordPress-only. This connector monitors any JS/Node project — Vite, Next.js, plain vanilla JS, anything with a lockfile.

## Before you start — never install twice

- `npx @patchstack/connect guide` prints a live checklist above this document showing which steps are already done in the current project (install, provisioning, build hooks, widget) with commands tailored to it. Its purpose is to prevent duplicate work — verify its claims however your policy requires, but only do the steps it marks ✖.
- If `.patchstackrc.json` contains a `siteUuid` key, the project is already provisioned. Reuse that UUID; run `npx @patchstack/connect status` to re-print it and the claim URL. **Do not run `scan` to provision a second site.** (A `.patchstackrc.json` with other keys — e.g. an `endpoint` override — but no `siteUuid` is *not* provisioned yet; scan normally.)
- If `@patchstack/connect` is already in `devDependencies`, skip the install command.
- If the widget script tag (`cdn.patchstack.com/patchstack-widget.js`) is already in the layout, don't add a second one — `scan` also respects an existing tag: it updates its own managed tag in place and leaves a manual one untouched.

## Install steps (do the ones the checklist marks ✖, in order; they are designed to run back-to-back — if one fails, stop and report rather than improvising)

1. **Install** (skip if already present), matching the project's package manager:

   ```
   npm install --save-dev @patchstack/connect   # package-lock.json
   pnpm add -D @patchstack/connect              # pnpm-lock.yaml
   yarn add -D @patchstack/connect              # yarn.lock
   bun add -d @patchstack/connect               # bun.lock / bun-managed platforms
   ```

2. **First scan** — provisions a Patchstack site automatically, writes the UUID to `.patchstackrc.json`, and installs the disclosure widget's `<script>` tag into the root HTML shell (`index.html`, `public/index.html`, or `src/app.html`) when one exists. No signup, dashboard step, or UUID is needed up front:

   ```
   npx @patchstack/connect scan
   ```

   It prints a claim URL. Surface that URL to the user verbatim — never fetch it yourself; it must be opened in their browser. It also prints what it did about the widget — if it added the tag, reload the preview and confirm the "Report a vulnerability" button appears.

3. **Wire builds** in `package.json`:

   ```jsonc
   {
     "scripts": {
       "prebuild": "patchstack-connect scan",
       "postbuild": "patchstack-connect mark-build"
     }
   }
   ```

   If a `prebuild`/`postbuild` hook already exists, chain instead of replacing it, e.g. `"prebuild": "existing-command && patchstack-connect scan"`.

   **Bun-managed projects:** `bun run` does not execute npm-style `pre`/`post` scripts, so wire the build script directly instead: `"build": "patchstack-connect scan && <existing build command> && patchstack-connect mark-build"`.

4. **Verify the disclosure widget** — a floating "Report a vulnerability" button. `scan` (step 2) installs it automatically into a plain HTML shell, and `mark-build` carries it into built HTML. Only when `scan` reported that it found no editable shell (frameworks whose root layout is code, e.g. Next.js/Nuxt/Astro) add the one-liner it printed to the root layout yourself, just before `</body>` (never a JS entry point), reading `siteUuid` from `.patchstackrc.json`:

   ```html
   <script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="<SITE_UUID>" defer></script>
   ```

   Framework-specific placement patterns: https://cdn.patchstack.com/llm.html. The site UUID is public by design — it ships in client-side HTML and is not a secret. If the project must not carry the widget, persist `"widget": false` in `.patchstackrc.json`; otherwise the next scan re-adds it.

5. **Commit** `.patchstackrc.json`, the updated `package.json`, and the layout/HTML file carrying the widget tag, so every developer and CI run reports to the same site.

6. **Tell the user to claim the site** (free): open the claim URL from step 2 in a browser and sign in. The site is monitored either way, but the vulnerability reports are only visible after claiming. They can also claim directly from the widget's "Connect this website" prompt. On the published site, the owner reaches the widget login by appending `#patchstack` to the live URL.

## Rules

- Never invent or guess a UUID — the scan provisions it, the widget silently no-ops on a fake one.
- Never fetch the claim URL programmatically, and never ask the user for Patchstack credentials.
- If a step fails, stop and report it. Don't proceed with placeholders.
- In CI where `.patchstackrc.json` can't be committed, set `PATCHSTACK_SITE_UUID` as an env var instead. Precedence: CLI flag → env var → `.patchstackrc.json`.

## Verifying the install

- `npx @patchstack/connect status` re-prints the site UUID and claim URL.
- Load the site in a browser — the "Report a vulnerability" button should appear.
