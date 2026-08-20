# Patchstack Connect — setup reference

This versioned reference ships inside `@patchstack/connect` and documents each setup command and its project changes.

## Package and command behavior

- Package: [`@patchstack/connect`](https://www.npmjs.com/package/@patchstack/connect), MIT-licensed, source at https://github.com/patchstack/connect. `npm view @patchstack/connect` shows the live registry metadata.
- **What is sent to Patchstack is the dependency list only** — read from the lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) or, on bun projects (`bun.lock`/`bun.lockb`), by enumerating the installed packages under `node_modules/` — package names + versions, for vulnerability matching. No source code, no env var values, no file paths, no git history is ever transmitted. (`mark-build` additionally stamps built HTML with a coarse stack descriptor that may include hosting-related env variable *names* — e.g. `VERCEL`, `CF_PAGES` — never their values.)
- **One command reads source files:** `map` (see below) parses your server source to report your app's attack surface. It runs only when you invoke it and prints to stdout. It transmits nothing unless you explicitly pass `--upload`, which sends that description of your app's structure to your own site's Patchstack endpoint — never source code, and never without that flag. No other command reads source (`protect` writes guard files but does not analyze your code).
- **`scan` makes one source edit, and only after a successful post:** it adds (or updates) the disclosure widget's `<script>` tag in the project's root HTML shell — the first of `index.html`, `public/index.html`, or `src/app.html` that exists. It touches no other file, never edits on `--dry-run` or after a failed post, leaves any pre-existing manual widget tag untouched, and is disabled entirely by `"widget": false` in `.patchstackrc.json`. `mark-build` writes to build output only (`dist/`, `build/`, `out/`, `.output/public`), never to source. `guide`, `status`, and `init` write nothing except `init`'s own `.patchstackrc.json`.
- **`setup` runs `scan`, then `protect`, then edits `package.json` scripts:** provisioning happens first so the runtime guard can bake the real site UUID. It verifies the resulting framework seam, preserves existing commands, adds `scan` after dependency installs and before builds, adds `mark-build` after builds, and uses a direct build chain for Bun. It never runs the project build. If the widget or runtime guard needs a framework-specific manual merge, it prints the exact remaining step instead of overwriting user code.
- The package also exposes **`protect`** directly (runtime exploit guard; its templates live under `dist/protect/`). `setup` invokes it automatically; `scan`, `guide`, `status`, and `mark-build` do not. It writes only local files and auto-wires known stacks — **TanStack Start + Supabase** (patches the Supabase client + `src/start.ts`), **Next.js** (scaffolds `middleware.ts`), **SvelteKit** (`src/hooks.server.ts`), **Astro** (`src/middleware.ts`), **Nuxt** (`server/middleware/`), **NestJS** (`app.use(patchstackMiddleware)` in the bootstrap), **Fastify** (`app.register(patchstackFastify)`), and **Express** (`app.use(patchstackMiddleware)`). On **any other stack** it scaffolds a framework-agnostic guard under `src/patchstack/` and prints a wiring plan — then you finish the install by importing that guard into your server entry (`protectFetch(handler)` for a Web-Fetch server, or `app.use(patchstackMiddleware)` for Node/Express) and running `patchstack-connect protect --check` to confirm it is wired (exit 1 until it is). Passing `--demo` seeds a broad sample rule set (for demonstrations, not production).
- **`demo node-serialize` is an explicit production-backed walkthrough.** It requires `node-serialize@0.0.4` to already be present in the lockfile; it does not install the vulnerable dependency. It runs the same production `scan`, polls the configured site's public Pulse rules endpoint until rule `18843` is served, runs `protect`, verifies the generated guard, and prints exploit/benign test requests. It writes the same manifest/widget and guard files as those underlying commands. It does not start/restart the app and does not send the printed requests.
- **`map` is a local, read-only analysis command.** It walks the project's server source (skipping `node_modules`, build output and dot-directories; it does not follow symlinks out of the project unless you pass `--follow-symlinks`), parses it with the project's **own** `typescript`, and prints JSON describing the attack surface: entry points, the inputs each reads, the sinks they can reach (database / file system / process / outbound HTTP) with the npm package behind each, and evidence-backed input→sink flows, each labelled with how the link was established — from an exact read at the sink's own call site, through a transformed or cross-module link, down to the two being present together with no proven link. Static analysis is best-effort, so the output reports the *detected* surface with coverage counters — not a completeness guarantee. It writes nothing (except the file you name with `--out`) and is never invoked by `scan`, `setup`, `guide`, `protect`, or `mark-build`.
- **`map --upload` is the one opt-in that sends anything derived from your source.** It POSTs the same JSON document to `monitor/pulse/input-map/<your site uuid>` so Patchstack can pin protection rules to your app's own parameter names instead of guessing them. What is sent is exactly what `map` prints — a structural description: route paths, parameter/field names, the dependency behind each sink, and file paths with line numbers. **No source code, no file contents, no environment variable values.** It never runs without the flag, it is skipped when no entry points are detected, and a failure to reach Patchstack is reported and ignored rather than failing your build. Omit the flag and the command stays entirely local.
- **`demo-guide node-serialize` is the read-only companion.** It checks the Host-created site configuration and vulnerable lockfile entry, explains the complete local prepare/run/restart/prove/cleanup sequence, and prints the next exact command. It does not require a deployment and does not change files or contact Patchstack.
- Patchstack is not WordPress-only. This connector monitors any JS/Node project — Vite, Next.js, plain vanilla JS, anything with a lockfile.

## Before you start — never install twice

- `npx @patchstack/connect guide` prints a read-only live checklist showing which steps are already done in the current project (install, provisioning, build hooks, widget, runtime protection).
- If `.patchstackrc.json` contains a `siteUuid` key, the project is already provisioned. Reuse that UUID; run `npx @patchstack/connect status` to re-print it and the dashboard URL. **Do not delete the file and provision a second site.** (A `.patchstackrc.json` with other keys — e.g. an `endpoint` override — but no `siteUuid` is *not* provisioned yet; scan normally.)
- If `@patchstack/connect` is already in `dependencies`, skip the install command. If it is only in `devDependencies`, move it with the matching package manager so production runtimes that prune dev dependencies can load the generated guard.
- If the widget script tag (`cdn.patchstack.com/patchstack-widget.js`) is already in the layout, don't add a second one — `scan` also respects an existing tag: it updates its own managed tag in place and leaves a manual one untouched.

## Automated setup

1. **Install** (skip if already present), matching the project's package manager:

   ```
   npm install --save @patchstack/connect   # package-lock.json
   pnpm add @patchstack/connect              # pnpm-lock.yaml
   yarn add @patchstack/connect              # yarn.lock
   bun add @patchstack/connect               # bun.lock / bun-managed platforms
   ```

2. **Run bounded setup:**

   ```
   npx @patchstack/connect setup
   ```

   This provisions or reuses the site, manages the widget, installs and verifies runtime protection, wires dependency-install and build scans, prints a dashboard link, and finishes with the same status shown by `guide`. Re-running it reuses existing configuration, widget tags, guards, and commands rather than duplicating them.

   In a hosted builder, run setup with `PATCHSTACK_ENVIRONMENT=sandbox` scoped to the workspace process/command, ensure the CLI's on-disk edits are adopted into the platform's persisted project state, then restart any already-running preview/server process so it loads the guard. Do not persist `"environment": "sandbox"` in `.patchstackrc.json`: deployed builds use the same committed files and should default to `production`. A client-only SPA has no server request path to guard; do not call it protected unless `protect --check` succeeds after a real server or edge seam is wired.

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
      "postbuild": "patchstack-connect mark-build",
      "postinstall": "patchstack-connect scan"
     }
   }
   ```

   If a lifecycle hook already exists, chain instead of replacing it, e.g. `"prebuild": "existing-command && patchstack-connect scan"`. The `postinstall` scan reports dependencies added during an iterative sandbox session and covers applications with no build command.

   **Bun-managed projects:** `bun run` does not execute npm-style `pre`/`post` scripts, so wire the build script directly instead: `"build": "patchstack-connect scan && <existing build command> && patchstack-connect mark-build"`.

3. **Verify the disclosure widget** — a floating "Report a vulnerability" button. `scan` installs it automatically into a plain HTML shell, and `mark-build` carries it into built HTML. Only when `scan` reported that it found no editable shell (frameworks whose root layout is code, e.g. Next.js/Nuxt/Astro) add the one-liner it printed to the root layout yourself, just before `</body>` (never a JS entry point), reading `siteUuid` from `.patchstackrc.json`:

   ```html
   <script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="<SITE_UUID>" defer></script>
   ```

   Framework-specific placement patterns: https://cdn.patchstack.com/llm.html. The site UUID is public by design — it ships in client-side HTML and is not a secret. The credentials are the opposite, and `scan` writes both of them for you — **there is no manual step, and you should never invent or ask the user for these values**:

- `apiKey` (also `PATCHSTACK_API_KEY`, WP format `{secret}-{oauth.id}`) — authenticates block-log reporting through the connector `POST /api/logs/log`, so "Threats blocked" fills in the dashboard.
- `pulseAuth` (also `PATCHSTACK_PULSE_AUTH`) — authenticates Pulse ingest: the manifest, the attack-surface map and package removal. Exchanged for a short-lived token rather than sent directly. Falls back to `apiKey` when absent, so older projects keep working.

Both are server-only. Never put either in the widget tag, client bundles, or public env vars (`NEXT_PUBLIC_*`, etc.). Prefer `PATCHSTACK_API_KEY` / `PATCHSTACK_PULSE_AUTH` in production; `.patchstackrc.json` is fine for local DX. If a credential is lost, `npx @patchstack/connect login` recovers it via dashboard approval — do not delete the file and re-provision, which would create a second site. Opt out of reporting with `PATCHSTACK_TELEMETRY=off`. If the project must not carry the widget, persist `"widget": false` in `.patchstackrc.json`; otherwise the next scan re-adds it.

4. **Install and verify runtime protection:**

   ```
   npx @patchstack/connect protect
   npx @patchstack/connect protect --check
   ```

   `setup` performs both steps automatically. The explicit commands are for manual setup or repair. If verification reports a generic or existing framework seam, complete the printed source edit and re-run `--check`; do not report protection as active until it exits successfully.

5. **Commit** `.patchstackrc.json`, the updated `package.json`, the guard/framework source changes, and the layout/HTML file carrying the widget tag, so every developer and CI run reports to the same site.

6. **Open the dashboard link** from the scan in a browser and sign in. The site is monitored either way, but the vulnerability reports are only visible after connecting it to an account. The same connection flow is available from the widget's "Connect this website" prompt. On the published site, the owner reaches the widget login by appending `#patchstack` to the live URL.

## Rules

- Never invent or guess a UUID — the scan provisions it, the widget silently no-ops on a fake one.
- The CLI never opens the dashboard link and never asks for Patchstack credentials.
- Label hosted workspace scans with `PATCHSTACK_ENVIRONMENT=sandbox` in that process only. Leave production builds unset (the default is `production`) and never commit a sandbox label into files shared with production.
- If a step fails, stop and report it. Don't proceed with placeholders.
- In CI where `.patchstackrc.json` can't be committed, set `PATCHSTACK_SITE_UUID` and `PATCHSTACK_PULSE_AUTH` as env vars instead. Precedence: CLI flag → env var → `.patchstackrc.json`. `login` is interactive and refuses to run in CI, so CI always takes its credential from the environment.

## Verifying the install

- `npx @patchstack/connect status` re-prints the site UUID and dashboard URL, and checks whether the site still exists on Patchstack (`Site status: active / removed / could not be verified`).
- `npx @patchstack/connect protect --check` verifies the runtime guard is connected to the request path.
- Load the site in a browser — the "Report a vulnerability" button should appear.

## Answering "is Patchstack installed?" / "is Patchstack removed?"

These are **two independent states** — never conflate them:

1. **The site record on Patchstack** (remote). Deleting the site in the dashboard or through the widget's uninstall flow removes it. Reporting stops and the widget stops rendering, but nothing in the project changes.
2. **The local integration** (this repo): the widget `<script>` tag, `.patchstackrc.json`, the `@patchstack/connect` dependency, the runtime guard files, and the build hooks.

Local files alone cannot tell you whether the site was removed from Patchstack. Run `npx @patchstack/connect status` and read the `Site status` line, then answer with both states. For example, when the site was removed but the local files remain, say: *"The site itself was removed from Patchstack — reporting has stopped and the widget no longer renders. The local integration code (widget tag, `.patchstackrc.json`, the dependency) is still in the project; want me to remove it?"* — not "Patchstack is still installed."

## Recovering a lost credential — `login`

Use this when the project **already has a site** but its credential is gone or rejected: `.patchstackrc.json` was deleted or never committed, the repo was cloned without it, a container was recycled, or ingest started failing with 401.

> **Do not "fix" a missing credential by deleting `.patchstackrc.json` and running `scan` again.** That provisions a **second site**, and the original — with all its history and its widget tag already live on the deployed page — is orphaned. `login` recovers the existing one.

### What it does

```
npx @patchstack/connect login

  Your code:  WDJB-MJHT
  Approve at: https://api.patchstack.com/monitor/pulse/device?code=WDJB-MJHT

  Waiting for approval…  ✓ Credential restored
```

The command asks Patchstack for a short code, prints a link, and polls until the site's **owner approves it in the dashboard**. On approval it writes the new credential into `.patchstackrc.json` and exits. The link opens the approval page with the code already filled in, so the person only has to confirm.

### What you must do, as the agent

1. **Run the command and surface the link and code to the user verbatim.** They must open it themselves — approval requires their signed-in Patchstack account, which you do not have and must not ask for.
2. **Leave the command running.** It polls until approved or the code expires (10 minutes). Do not kill it and retry; each run issues a different code and invalidates the one already on screen.
3. **Report the outcome.** On success, tell them the credential was restored *and* that the previous one no longer works — see the warning below.

You cannot complete this alone. It is deliberately a human-in-the-loop step: starting the flow proves nothing about who is running it, so the only authorisation is an owner approving in the browser.

### Consequences to tell the user about

**Approving rotates the credential — the old one stops working immediately.** Anywhere it was configured needs the new value: CI secrets, hosting-platform env vars, preview environments, other developers' checkouts. Say this before they approve, not after.

### When it will not work

| Situation | What happens | What to do |
|---|---|---|
| Site was never claimed | `409` — no owner exists to approve | Ask the user to claim the site in the dashboard first, or, if the site is disposable, delete `.patchstackrc.json` and `scan` to provision a fresh one |
| Running in CI | Refuses to start | CI takes its credential from `PATCHSTACK_PULSE_AUTH`; `login` is for a developer machine |
| No `siteUuid` configured | Refuses to start | There is no site to recover — run `scan` |
| Code expired | Poll ends after 10 minutes | Run the command again for a new code |

## Uninstalling

Remove only the pieces that are actually present — check for each first. If none are present, Patchstack isn't installed; report that and stop. If the user asked to remove only one piece (e.g. "just the widget"), remove only that piece.

1. **Read the site UUID from `.patchstackrc.json` before deleting anything.** It is the only local record of the provisioned site — report it to the user at the end so they can identify the site in their dashboard.
2. **Remove the widget snippets** from the layout/template: the `<script src="https://cdn.patchstack.com/patchstack-widget.js">` tag and any `PatchstackWidget.init(...)` call (which may live in a separate client component/plugin/effect). Afterwards, grep the repo for `patchstack-widget` and `PatchstackWidget` to confirm nothing remains.
3. **Remove runtime protection before uninstalling the package.** Delete the connector-managed guard/rules files and remove only their managed imports, middleware registrations, tunnel code, and `#region patchstack…` blocks from the framework/server files. Preserve unrelated middleware and application code. Run `rg "patchstack|x-ps-target"` (or the available equivalent) afterwards and inspect every remaining source hit.
4. **Remove the hooks from `package.json` scripts.** If a hook was chained (e.g. `"postbuild": "existing-command && patchstack-connect mark-build"`), remove only the `patchstack-connect …` part and keep the rest; if removal leaves a script empty, delete the key.
5. **Signal Patchstack that the package is being removed**: run `npx @patchstack/connect uninstall` (while the package is still installed and `.patchstackrc.json` still exists). If the site was never claimed, this deletes its anonymous record on Patchstack; if the site is claimed, it is only flagged — the record stays until its owner removes it in the dashboard. A failed signal must not stop the uninstall; continue with the remaining steps.
6. **Uninstall the package** with the manager matching the lockfile: `npm uninstall` / `pnpm remove` / `yarn remove` / `bun remove` `@patchstack/connect`. Don't hand-edit `node_modules` or the lockfile.
7. **Delete `.patchstackrc.json`** and remove `PATCHSTACK_SITE_UUID`, `PATCHSTACK_API_KEY` (and public-prefixed variants like `NEXT_PUBLIC_PATCHSTACK_SITE_UUID`) from env files and CI variables.
8. **Commit** the changes. Reporting stops immediately. The `window.__PATCHSTACK_PROD__` flag that `mark-build` injected lives only in build output, never in source — the next build simply won't contain it (rebuild if build output is committed).

The `uninstall` signal is the only account-side effect local removal can have: it deletes an *unclaimed* (anonymous) record and merely flags a *claimed* one. A claimed site keeps using a site slot until its owner removes it in the dashboard at https://app.patchstack.com — end your report by telling the user this, alongside the site UUID from step 1. Never attempt to authenticate or remove a claimed site on the user's behalf.

The reverse also holds: removing the site on Patchstack's side (dashboard delete or the widget's uninstall flow) does not touch these local files — they must still be removed with the steps above. `npx @patchstack/connect status` shows `Site status: removed from Patchstack` in that state.
