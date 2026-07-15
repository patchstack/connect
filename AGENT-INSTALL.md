# Patchstack Connect — setup reference

This versioned reference ships inside `@patchstack/connect` and documents each setup command and its project changes.

## Package and command behavior

- Package: [`@patchstack/connect`](https://www.npmjs.com/package/@patchstack/connect), MIT-licensed, source at https://github.com/patchstack/connect. `npm view @patchstack/connect` shows the live registry metadata.
- It reads the project's **dependency list only** — from the lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) or, on bun projects (`bun.lock`/`bun.lockb`), by enumerating the installed packages under `node_modules/` — and sends package names + versions to Patchstack for vulnerability matching. No source code, no env var values, no file paths, no git history. (`mark-build` additionally stamps built HTML with a coarse stack descriptor that may include hosting-related env variable *names* — e.g. `VERCEL`, `CF_PAGES` — never their values.)
- **`scan` makes one source edit, and only after a successful post:** it adds (or updates) the disclosure widget's `<script>` tag in the project's root HTML shell — the first of `index.html`, `public/index.html`, or `src/app.html` that exists. It touches no other file, never edits on `--dry-run` or after a failed post, leaves any pre-existing manual widget tag untouched, and is disabled entirely by `"widget": false` in `.patchstackrc.json`. `mark-build` writes to build output only (`dist/`, `build/`, `out/`, `.output/public`), never to source. `guide`, `status`, and `init` write nothing except `init`'s own `.patchstackrc.json`.
- **`setup` runs `scan`, then edits only `package.json` build scripts:** it preserves existing commands, adds `scan` before builds and `mark-build` after builds, and uses a direct build chain for Bun. It never runs the project build or `protect`. If the widget needs a framework-specific source edit, it prints the exact remaining step instead of rewriting framework code.
- The package also bundles an **opt-in** `protect` command (runtime exploit guard; its templates live under `dist/protect/`). It runs **only** when explicitly invoked; `scan`, `setup`, `guide`, `status`, and `mark-build` never invoke it, and it writes only local files. It auto-wires known stacks — **TanStack Start + Supabase** (patches the Supabase client + `src/start.ts`), **Next.js** (scaffolds `middleware.ts`), **SvelteKit** (`src/hooks.server.ts`), **Astro** (`src/middleware.ts`), **NestJS** (`app.use(patchstackMiddleware)` in the bootstrap), **Fastify** (`app.register(patchstackFastify)`), and **Express** (`app.use(patchstackMiddleware)`). On **any other stack** it scaffolds a framework-agnostic guard under `src/patchstack/` and prints a wiring plan — then you finish the install by importing that guard into your server entry (`protectFetch(handler)` for a Web-Fetch server, or `app.use(patchstackMiddleware)` for Node/Express) and running `patchstack-connect protect --check` to confirm it is wired (exit 1 until it is). Passing `--demo` seeds a broad sample rule set (for demonstrations, not production).
- Patchstack is not WordPress-only. This connector monitors any JS/Node project — Vite, Next.js, plain vanilla JS, anything with a lockfile.

## Before you start — never install twice

- `npx @patchstack/connect guide` prints a read-only live checklist showing which steps are already done in the current project (install, provisioning, build hooks, widget).
- If `.patchstackrc.json` contains a `siteUuid` key, the project is already provisioned. Reuse that UUID; run `npx @patchstack/connect status` to re-print it and the dashboard URL. **Do not delete the file and provision a second site.** (A `.patchstackrc.json` with other keys — e.g. an `endpoint` override — but no `siteUuid` is *not* provisioned yet; scan normally.)
- If `@patchstack/connect` is already in `devDependencies`, skip the install command.
- If the widget script tag (`cdn.patchstack.com/patchstack-widget.js`) is already in the layout, don't add a second one — `scan` also respects an existing tag: it updates its own managed tag in place and leaves a manual one untouched.

## Automated setup

1. **Install** (skip if already present), matching the project's package manager:

   ```
   npm install --save-dev @patchstack/connect   # package-lock.json
   pnpm add -D @patchstack/connect              # pnpm-lock.yaml
   yarn add -D @patchstack/connect              # yarn.lock
   bun add -d @patchstack/connect               # bun.lock / bun-managed platforms
   ```

2. **Run bounded setup:**

   ```
   npx @patchstack/connect setup
   ```

   This provisions or reuses the site, manages the widget, wires the build scripts, prints a dashboard link, and finishes with the same status shown by `guide`. Re-running it reuses existing configuration, widget tags, and build commands rather than duplicating them.

## Manual setup

1. **First scan** — provisions a Patchstack site automatically, writes the UUID to `.patchstackrc.json`, and installs the disclosure widget's `<script>` tag into the root HTML shell (`index.html`, `public/index.html`, or `src/app.html`) when one exists. No signup, dashboard step, or UUID is needed up front:

   ```
   npx @patchstack/connect scan
   ```

   It prints a dashboard link but never opens it. Open that link in a browser to view reports. It also prints what it did about the widget — if it added the tag, reload the preview and confirm the "Report a vulnerability" button appears.

2. **Wire builds** in `package.json`:

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

3. **Verify the disclosure widget** — a floating "Report a vulnerability" button. `scan` installs it automatically into a plain HTML shell, and `mark-build` carries it into built HTML. Only when `scan` reported that it found no editable shell (frameworks whose root layout is code, e.g. Next.js/Nuxt/Astro) add the one-liner it printed to the root layout yourself, just before `</body>` (never a JS entry point), reading `siteUuid` from `.patchstackrc.json`:

   ```html
   <script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="<SITE_UUID>" defer></script>
   ```

   Framework-specific placement patterns: https://cdn.patchstack.com/llm.html. The site UUID is public by design — it ships in client-side HTML and is not a secret. If the project must not carry the widget, persist `"widget": false` in `.patchstackrc.json`; otherwise the next scan re-adds it.

4. **Commit** `.patchstackrc.json`, the updated `package.json`, and the layout/HTML file carrying the widget tag, so every developer and CI run reports to the same site.

5. **Open the dashboard link** from the scan in a browser and sign in. The site is monitored either way, but the vulnerability reports are only visible after connecting it to an account. The same connection flow is available from the widget's "Connect this website" prompt. On the published site, the owner reaches the widget login by appending `#patchstack` to the live URL.

## Rules

- Never invent or guess a UUID — the scan provisions it, the widget silently no-ops on a fake one.
- The CLI never opens the dashboard link and never asks for Patchstack credentials.
- If a step fails, stop and report it. Don't proceed with placeholders.
- In CI where `.patchstackrc.json` can't be committed, set `PATCHSTACK_SITE_UUID` as an env var instead. Precedence: CLI flag → env var → `.patchstackrc.json`.

## Verifying the install

- `npx @patchstack/connect status` re-prints the site UUID and dashboard URL.
- Load the site in a browser — the "Report a vulnerability" button should appear.

## Uninstalling

Remove only the pieces that are actually present — check for each first. If none are present, Patchstack isn't installed; report that and stop. If the user asked to remove only one piece (e.g. "just the widget"), remove only that piece.

1. **Read the site UUID from `.patchstackrc.json` before deleting anything.** It is the only local record of the provisioned site — report it to the user at the end so they can identify the site in their dashboard.
2. **Remove the widget snippets** from the layout/template: the `<script src="https://cdn.patchstack.com/patchstack-widget.js">` tag and any `PatchstackWidget.init(...)` call (which may live in a separate client component/plugin/effect). Afterwards, grep the repo for `patchstack-widget` and `PatchstackWidget` to confirm nothing remains.
3. **Remove the hooks from `package.json` scripts.** If a hook was chained (e.g. `"postbuild": "existing-command && patchstack-connect mark-build"`), remove only the `patchstack-connect …` part and keep the rest; if removal leaves a script empty, delete the key.
4. **Uninstall the package** with the manager matching the lockfile: `npm uninstall` / `pnpm remove` / `yarn remove` / `bun remove` `@patchstack/connect`. Don't hand-edit `node_modules` or the lockfile.
5. **Delete `.patchstackrc.json`** and remove `PATCHSTACK_SITE_UUID` (and public-prefixed variants like `NEXT_PUBLIC_PATCHSTACK_SITE_UUID`) from env files and CI variables.
6. **Commit** the changes. Reporting stops immediately. The `window.__PATCHSTACK_PROD__` flag that `mark-build` injected lives only in build output, never in source — the next build simply won't contain it (rebuild if build output is committed).

Local removal does not delete the site record on Patchstack's side. An unclaimed site is an anonymous record that stops receiving reports; a claimed site is removed by the user in their dashboard at https://app.patchstack.com. There is no CLI command for account-side deletion — do not invent one, and never attempt to authenticate or remove the site on the user's behalf.
