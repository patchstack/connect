# Patchstack Connect — setup reference

This versioned reference ships inside `@patchstack/connect` and documents each setup command and its project changes.

## Command reference

Every command at a glance — what it does, whether it reads your source, what it writes, and what leaves your machine. Full behavior, flags, and edge cases follow in the sections below.

| Command | What it does | Reads your source? | Writes to your project | Sends over the network |
|---|---|---|---|---|
| `scan` | Provision (or reuse) the site and POST the dependency list for vulnerability matching. Also runs automatically via `setup` and the install/build hooks. | No — lockfile only; `node_modules/` is enumerated when no lockfile can be read (e.g. `bun.lockb`) or when the lockfiles present disagree | `.patchstackrc.json` (public: site UUID + settings); `.patchstackrc.local.json` (the API key, created owner-only) and a `.gitignore` entry for it — the CLI says so if it could not add one; the widget `<script>` tag in the root HTML shell — only after a successful post; the production marker in a code root shell — before the post, since it needs no site UUID | Package names + versions |
| `setup` | One bounded command: `scan` → manage the widget → install + verify `protect` → wire the install/build scans. Never runs the project build. | No | Config, widget tag, production marker, guard files, `package.json` scripts | Package names + versions (via `scan`) |
| `map` | Local, read-only attack-surface analysis (entry points → inputs → sinks → evidence-backed flows). Never run by another command. | **Yes** — via the app's own TypeScript | Nothing (only the file named by `--out`) | Nothing — **unless `--upload`**: structure only (routes, parameter names, the package behind each sink, file:line). Never source code or env values |
| `protect` | Install the always-on runtime guard; auto-wire known stacks, or scaffold a generic guard + print a wiring plan. `--check` verifies the guard is wired (exit 1 if not); `--demo` seeds a broad sample rule set. Runs automatically **only** via `setup` — never by `scan`, `guide`, `status`, or `mark-build`. | No — writes guard files, does not analyze your code | Guard/framework files (e.g. `middleware.ts`, `src/patchstack/`) | Nothing |
| `demo node-serialize` | Production-backed walkthrough: confirm the vulnerable package is present, scan, wait for live rule `18843`, install + verify the guard, print test requests. Does not install the package or start/restart the app. | No | Same files as `scan` + `protect` | `scan` payload; polls the public Pulse rules endpoint (never the printed test requests) |
| `demo-guide node-serialize` | Read-only companion: explains the prepare/run/prove/cleanup sequence and prints the next command. | No | Nothing | Nothing |
| `guide` | Print this project's live setup status (done/missing, with tailored commands), then the full guide. `--full` prints it even when setup is complete. | No | Nothing | Nothing |
| `status` | Re-print the site UUID + dashboard URL and check whether the site still exists (active / removed / could not verify). | No | Nothing | Site-existence check |
| `init <site-uuid>` | Optional: pre-seed `.patchstackrc.json` with an existing UUID. | No | `.patchstackrc.json` only | Nothing |
| `mark-build` | Stamp built HTML with a production flag + build fingerprint and ensure the widget tag in built pages. Run as a `postbuild` step. | No | Build output only (`dist/ build/ out/ .output/public`) — never source | Nothing |
| `login` | Recover a lost credential for an existing site: print an owner-approval link and poll (10 min). Approving **rotates** the credential. Not usable in CI. | No | New credential into `.patchstackrc.local.json` on approval | Device-code request + approval poll |
| `uninstall` | Signal Patchstack that the package is being removed: an unclaimed record is deleted, a claimed one is flagged. Does **not** touch local files. | No | Nothing local | Removal signal |

Only `map` reads your source, and only `map --upload` sends anything derived from it. `scan` transmits nothing but package names + versions — never source code, env var values, file paths, or git history. `scan --install-paths` additionally sends where each package sits in the dependency tree; it is off unless you pass it.

## Package and command behavior

- Package: [`@patchstack/connect`](https://www.npmjs.com/package/@patchstack/connect), MIT-licensed, source at https://github.com/patchstack/connect. `npm view @patchstack/connect` shows the live registry metadata.
- **What is sent to Patchstack is the dependency list only** — read from the lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) or, on bun projects (`bun.lock`/`bun.lockb`), by enumerating the installed packages under `node_modules/` — package names + versions, for vulnerability matching. No source code, no env var values, no file paths, no git history is ever transmitted.
  - **`scan --install-paths` is the one exception, and it is opt-in.** It adds where each package sits in the dependency tree — repo-relative paths made of `node_modules` segments, plus a workspace directory name when a workspace pins its own copy. They are read from the lockfile's own keys or from the `node_modules` walk, **never from your source tree**: no path to a file you wrote is sent by either form of `scan`.
  - Why it exists: the same package is routinely installed twice at different versions, and without the locations an advisory affecting only one of them cannot be matched to the copy your code actually loads. Node resolves an import by walking up from the importing file, so the location is what distinguishes "you are running the vulnerable copy" from "the vulnerable copy is installed but nothing reaches it". Absent them, every installed version has to be treated as if the app used it — warnings about code you never call, and protection rules pinned to routes that run the safe copy.
  - Why it is off by default: it widens what leaves the machine, so it is your explicit choice and not a consequence of upgrading the package. (`mark-build` additionally stamps built HTML with a coarse stack descriptor that may include hosting-related env variable *names* — e.g. `VERCEL`, `CF_PAGES` — never their values.)
- **One command reads source files:** `map` (see below) parses your server source to report your app's attack surface. It runs only when you invoke it and prints to stdout. It transmits nothing unless you explicitly pass `--upload`, which sends that description of your app's structure to your own site's Patchstack endpoint — never source code, and never without that flag. No other command reads source (`protect` writes guard files but does not analyze your code).
- **`scan` makes up to two source edits, both in the project's root shell:** the disclosure widget's `<script>` tag, and the production marker. Neither runs on `--dry-run`, both are idempotent, both leave a pre-existing manual install untouched, and `"widget": false` in `.patchstackrc.json` disables both.
  - The **widget tag** goes in the root HTML shell — the first of `index.html`, `public/index.html`, or `src/app.html` that exists — and only after a successful post, because it carries the site UUID.
  - The **production marker** goes in a root shell that is JSX rather than HTML (e.g. `src/routes/__root.tsx`, `app/layout.tsx`), inside a `{/* #region patchstack */}` block placed above the widget tag. It is written *before* the post: it carries no site UUID and needs no network, and build scripts commonly chain `patchstack-connect scan || true`, where waiting on the server would mean an offline build silently ships without the flag. The marker is guarded by the framework's own production expression (`import.meta.env.PROD`, or `process.env.NODE_ENV === 'production'`), so it is inert in dev and preview builds. Without it a server-rendered site has no built HTML for `mark-build` to stamp, and the widget treats the published site as build mode. `mark-build` writes to build output only (`dist/`, `build/`, `out/`, `.output/public`), never to source. `guide`, `status`, and `init` write nothing except `init`'s own `.patchstackrc.json`.
- **`setup` runs `scan`, then `protect`, then edits `package.json` scripts:** provisioning happens first so the runtime guard can bake the real site UUID. It verifies the resulting framework seam, preserves existing commands, adds `scan` after dependency installs and before builds, adds `mark-build` after builds, and uses a direct build chain for Bun. It never runs the project build. If the widget or runtime guard needs a framework-specific manual merge, it prints the exact remaining step instead of overwriting user code.
- The package also exposes **`protect`** directly (runtime exploit guard; its templates live under `dist/protect/`). `setup` invokes it automatically; `scan`, `guide`, `status`, and `mark-build` do not. It writes only local files and auto-wires known stacks — **TanStack Start + Supabase** (patches the Supabase client + `src/start.ts`), **Next.js** (scaffolds `middleware.ts`), **SvelteKit** (`src/hooks.server.ts`), **Astro** (`src/middleware.ts`), **Nuxt** (`server/middleware/`), **NestJS** (`app.use(patchstackMiddleware)` in the bootstrap), **Fastify** (`app.register(patchstackFastify)`), and **Express** (`app.use(patchstackMiddleware)`). On **any other stack** it scaffolds a framework-agnostic guard under `src/patchstack/` and prints a wiring plan — then you finish the install by importing that guard into your server entry (`protectFetch(handler)` for a Web-Fetch server, or `app.use(patchstackMiddleware)` for Node/Express) and running `patchstack-connect protect --check` to confirm it is wired (exit 1 until it is). Passing `--demo` seeds a broad sample rule set (for demonstrations, not production).
- **`demo node-serialize` is an explicit production-backed walkthrough.** It requires `node-serialize@0.0.4` to already be present in the lockfile; it does not install the vulnerable dependency. It runs the same production `scan`, polls the configured site's public Pulse rules endpoint until rule `18843` is served, runs `protect`, verifies the generated guard, and prints exploit/benign test requests. It writes the same manifest/widget and guard files as those underlying commands. It does not start/restart the app and does not send the printed requests.
- **`map` is a local, read-only analysis command.** It walks the project's server source (skipping `node_modules`, build output and dot-directories; it does not follow symlinks out of the project unless you pass `--follow-symlinks`), parses it with the project's **own** `typescript`, and prints JSON describing the attack surface: entry points, the inputs each reads, the sinks they can reach (database / file system / process / outbound HTTP) with the npm package behind each, and evidence-backed input→sink flows, each labelled with how the link was established — from an exact read at the sink's own call site, through a transformed or cross-module link, down to the two being present together with no proven link. Static analysis is best-effort, so the output reports the *detected* surface with coverage counters — not a completeness guarantee. It writes nothing (except the file you name with `--out`) and is never invoked by `scan`, `setup`, `guide`, `protect`, or `mark-build`.
- **`map --upload` is the only command that sends a description of your source.** (The runtime guard can also report rule detections, which carry route paths and parameter names — see "Runtime guard reporting" below.) It POSTs the same JSON document to `monitor/pulse/input-map/<your site uuid>` so Patchstack can pin protection rules to your app's own parameter names instead of guessing them. What is sent is exactly what `map` prints — a structural description: route paths, parameter/field names, the dependency behind each sink, and file paths with line numbers. **No source code, no file contents, no environment variable values.** It never runs without the flag, it is skipped when no entry points are detected, and a failure to reach Patchstack is reported and ignored rather than failing your build. Omit the flag and the command stays entirely local.
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

1. **First scan** — provisions a Patchstack site automatically, writes the UUID to `.patchstackrc.json`, and installs the disclosure widget's `<script>` tag into the root HTML shell (`index.html`, `public/index.html`, or `src/app.html`) when one exists — or, when the root shell is JSX, the production marker instead. No signup, dashboard step, or UUID is needed up front:

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

3. **Verify the disclosure widget** — a floating "Report a vulnerability" button. `scan` installs it automatically into a plain HTML shell, and `mark-build` carries it into built HTML. Only when `scan` reported that it found no editable shell (frameworks whose root layout is code, e.g. Next.js/Nuxt/Astro) add the one-liner it printed to the root layout yourself, just before `</body>` (never a JS entry point), reading `siteUuid` from `.patchstackrc.json`. On those same roots the widget also needs the production marker above the tag — `scan` adds it automatically to a JSX root, and prints it to paste when it finds no anchor. A server-rendered site without the marker serves the build-mode claim flow to its visitors:

   ```html
   <script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="<SITE_UUID>" defer></script>
   ```

   Framework-specific placement patterns: https://cdn.patchstack.com/llm.html. The site UUID is public by design — it ships in client-side HTML and is not a secret. The credential is the opposite, and `scan` writes it for you — **there is no manual step, and you should never invent or ask the user for this value**:

- `apiKey` (in `.patchstackrc.local.json`, which is git-ignored; also `PATCHSTACK_API_KEY`, WP format `{secret}-{oauth.id}`) — one credential for both paths. It authenticates **Pulse ingest** (manifest, attack-surface map, package removal, rule detections), where it is exchanged for a short-lived token rather than sent directly, and **block-log reporting** through the connector `POST /api/logs/log`, so "Threats blocked" fills in the dashboard.

It is server-only. Never put it in the widget tag, client bundles, or public env vars (`NEXT_PUBLIC_*`, etc.). Prefer `PATCHSTACK_API_KEY` in production; the git-ignored `.patchstackrc.local.json` is fine for local DX. If it is lost, `npx @patchstack/connect login` recovers it via dashboard approval — do not delete the file and re-provision, which would create a second site. Opt out of reporting with `PATCHSTACK_TELEMETRY=off`. If the project must not carry the widget, persist `"widget": false` in `.patchstackrc.json`; otherwise the next scan re-adds it.

   A `pulseAuth` field is still honoured if a project has one, and `PATCHSTACK_PULSE_AUTH` still overrides it, for deployments that authenticate Pulse ingest with a different credential from block-logs. Do not add either yourself: they are unnecessary when the two share one credential, which is the default.

4. **Install and verify runtime protection:**

   ```
   npx @patchstack/connect protect
   npx @patchstack/connect protect --check
   ```

   `setup` performs both steps automatically. The explicit commands are for manual setup or repair. If verification reports a generic or existing framework seam, complete the printed source edit and re-run `--check`; do not report protection as active until it exits successfully.

5. **Commit** `.patchstackrc.json`, the updated `package.json`, the guard/framework source changes, and the layout/HTML file carrying the widget tag (and the production marker, when `scan` wrote one into a JSX root), so every developer and CI run reports to the same site.

   **Do not commit `.patchstackrc.local.json`.** That file holds the API key issued at provision; the scan writes it and adds it to `.gitignore`, and tells you if it could not. `.patchstackrc.json` holds only the site UUID and settings, and the UUID is public by design — it ships in the widget tag in served HTML.

6. **Open the dashboard link** from the scan in a browser and sign in. The site is monitored either way, but the vulnerability reports are only visible after connecting it to an account. The same connection flow is available from the widget's "Connect this website" prompt. On the published site, the owner reaches the widget login by appending `#patchstack` to the live URL.

## Rules

- Never invent or guess a UUID — the scan provisions it, the widget silently no-ops on a fake one.
- The CLI never opens the dashboard link and never asks for Patchstack credentials.
- Label hosted workspace scans with `PATCHSTACK_ENVIRONMENT=sandbox` in that process only. Leave production builds unset (the default is `production`) and never commit a sandbox label into files shared with production.
- If a step fails, stop and report it. Don't proceed with placeholders.
- CI never has the credential in a file: `.patchstackrc.local.json` is git-ignored by design, so set `PATCHSTACK_API_KEY` as an env var there (and `PATCHSTACK_SITE_UUID` too where `.patchstackrc.json` is also absent). Precedence for the site UUID and settings: CLI flag → env var → `.patchstackrc.json`. For the API key: env var → `.patchstackrc.local.json` → `.patchstackrc.json` (where installs made before the split still hold it). `login` is interactive and refuses to run in CI, so CI always takes its credential from the environment.

## Runtime guard reporting

The runtime guard (`protect`) can report the rules that matched, so the dashboard can show what a rule
would have stopped while it is still in dry-run. Two separate paths, with different triggers:

- **Blocked requests** go to the connector `POST /api/logs/log`, the same path the WordPress plugin uses,
  and fill in "Threats blocked". This runs when the guard is holding an `apiKey` and a rule blocked a
  request. The credential is first exchanged at `POST /oauth/token` (client credentials) for a bearer
  token; the `apiKey` itself is not sent to the log endpoint. Disable with `PATCHSTACK_TELEMETRY=off`, or
  `reportFirewallLog: false` in `createProtection`.
- **Every rule that matched** goes to `monitor/pulse/detections/<your site uuid>` — including matches that
  blocked, which are reported on both paths. This is **off unless you pass `reportDetections: true`** to
  `createProtection`; the scaffolded guard does not pass it. It also requires a provisioned site UUID, a
  resolvable credential, and is disabled by `PATCHSTACK_TELEMETRY=off`. It exists because a rule carrying
  `dry-run` blocks nothing, so without it nothing distinguishes a rule that is protecting from one that is
  quietly wrong.

What a detection report contains, per matched rule: the rule id, the request path **with any query string
removed**, the parameter names that rule reads (from the rule's own definition), which phase matched,
whether it was enforced, the identifier of the rule bundle in use, the revision of the rule itself when the
bundle carried one, and a timestamp. Each batch also
carries a count of reports dropped when traffic outran the flush, so a partial sample is not read as a
complete one.

The parameter names are **identifiers, and they name the request region they refer to** — `post.title`,
`get.redirect_to`, `cookie.session`, `server.HTTP_AUTHORIZATION`. So a rule that inspects a cookie or an
`Authorization` header sends that cookie's or header's **name**. They are read from the rule's own
definition, not from your traffic, so they describe what is being screened rather than what any request
contained.

What it does not contain: **no values of any kind.** Not the value that matched, not the request body,
and not the value of any header, cookie or query-string parameter — including those of the parameters
named above. Reports are batched, capped in memory, and dropped rather than retried if Patchstack cannot
be reached — a reporting failure never delays or fails a request.

The endpoint needs a credential, so `reportDetections: true` with none resolved starts nothing: the guard
warns once at boot and `protection.detectionReporting` reads `unavailable-no-credential` instead of `on`.
When reporting is on, `protection.detectionHealth()` returns local counts — detections attempted,
acknowledged, refused or unreachable, dropped for queue pressure — and the time of the last
acknowledgement. Those counts stay in your process; nothing extra is sent to report them.

`protection.stop()` stops everything the guard has running in the background — the rule-refresh loop, the
block-log reporter, the detection reporter — and flushes what is buffered. `protection.stopRefresh()` is
the same method under its older name. Call it on shutdown; it is safe to call twice.

Two more endpoints the package can call, for completeness:

- `GET monitor/widget/settings/<your site uuid>` — how `status` tells "this site was deleted on
  Patchstack" apart from "still active". It sends no credential and nothing about your project; the site
  UUID in the path is the whole request.
- `GET api/get-rules/3` — the older rules path, used only when the guard is configured with a `token`
  instead of a site UUID. The zero-configuration flow provisions a site UUID and uses
  `monitor/pulse/rules/<uuid>` instead, so this is unreachable unless you pass `token` yourself.

## Verifying the install

- `npx @patchstack/connect status` re-prints the site UUID and dashboard URL, and checks whether the site still exists on Patchstack (`Site status: active / removed / could not be verified`).
- `npx @patchstack/connect protect --check` verifies the runtime guard is connected to the request path.
- Load the site in a browser — the "Report a vulnerability" button should appear.

## Answering "is Patchstack installed?" / "is Patchstack removed?"

These are **two independent states** — never conflate them:

1. **The site record on Patchstack** (remote). Deleting the site in the dashboard or through the widget's uninstall flow removes it. Reporting stops and the widget stops rendering, but nothing in the project changes.
2. **The local integration** (this repo): the widget `<script>` tag, `.patchstackrc.json`, the `@patchstack/connect` dependency, the runtime guard files, and the build hooks.

Local files alone cannot tell you whether the site was removed from Patchstack. Run `npx @patchstack/connect status` and read the `Site status` line, then answer with both states. For example, when the site was removed but the local files remain, say: *"The site itself was removed from Patchstack — reporting has stopped and the widget no longer renders. The local integration code (widget tag, `.patchstackrc.json`, `.patchstackrc.local.json`, the dependency) is still in the project; want me to remove it?"* — not "Patchstack is still installed."

## Recovering a lost credential — `login`

Use this when the project **already has a site** but its credential is gone or rejected: `.patchstackrc.local.json` was deleted, the repo was cloned without it (it is git-ignored, so a fresh clone never has it), a container was recycled, or ingest started failing with 401. The site UUID `login` needs comes from the committed `.patchstackrc.json`.

> **Do not "fix" a missing credential by deleting `.patchstackrc.json` and running `scan` again.** That file holds the site UUID, and without it `scan` provisions a **second site** — the original, with all its history and its widget tag already live on the deployed page, is orphaned. `login` recovers the credential for the site you already have.

### What it does

```
npx @patchstack/connect login

  Your code:  WDJB-MJHT
  Approve at: https://api.patchstack.com/monitor/pulse/device?code=WDJB-MJHT

  Waiting for approval…  ✓ Credential restored
```

The command asks Patchstack for a short code, prints a link, and polls until the site's **owner approves it in the dashboard**. On approval it writes the new credential into `.patchstackrc.local.json`, reports whether that file is covered by `.gitignore`, and exits. The link opens the approval page with the code already filled in, so the person only has to confirm.

### What you must do, as the agent — two commands, not one

**The command exits immediately when you run it.** It detects that its output is being captured rather than watched by a person, prints the link, and returns. It does **not** block waiting for approval, because you would not see the link until it exited — by which time the code would have expired, and it would look like the command had hung.

```
1.  npx @patchstack/connect login     → prints the link, exits straight away
2.  give the user the link, verbatim  → they approve it in the browser
3.  npx @patchstack/connect login     → the SAME command again, after they confirm.
                                        It resumes the request and finishes the flow
```

- **Never wrap step 1 in a timeout or kill it** — it returns on its own. If you find yourself waiting on it, something else is wrong.
- **Step 3 is the same command.** While a request is still valid it resumes rather than restarting, so running `login` again never invalidates the link the user is looking at. If they have not approved yet it tells you so, with the time remaining, and exits.
- **Nothing changes until step 3 runs.** Approving only marks the request; the credential is rotated and written when the CLI redeems it. So an abandoned flow is harmless — the site keeps working — but the credential is not restored until you come back.
- **Surface the link verbatim.** Approval requires the user's signed-in Patchstack account, which you do not have and must never ask for.
- **Report the outcome.** On success, say the credential was restored *and* that the previous one no longer works — see the warning below.

`login --wait` is the blocking variant: it polls until approved instead of returning. Prefer the plain re-run — it keeps each command short, which is what fits a conversation.

You cannot complete this alone. It is deliberately a human-in-the-loop step: starting the flow proves nothing about who is running it, so the only authorisation is an owner approving in the browser.

(In an interactive terminal the same command prints the link and then waits, since a person can watch it stream. You get the two-step form; a human at a shell gets the one-step form.)

### Consequences to tell the user about

**Approving rotates the credential — the old one stops working immediately.** Anywhere it was configured needs the new value: CI secrets, hosting-platform env vars, preview environments, other developers' checkouts. Say this before they approve, not after.

### When it will not work

| Situation | What happens | What to do |
|---|---|---|
| Site was never claimed | `409` — no owner exists to approve | Ask the user to claim the site in the dashboard first, or, if the site is disposable, delete `.patchstackrc.json` **and** `.patchstackrc.local.json` and `scan` to provision a fresh one — leaving the old credential behind means the next scan starts out holding one that belongs to a different site |
| Running in CI | Refuses to start | CI takes its credential from `PATCHSTACK_PULSE_AUTH`; `login` is for a developer machine |
| No `siteUuid` configured | Refuses to start | There is no site to recover — run `scan` |
| Code expired | `--wait` ends after 10 minutes | Start again from step 1 for a new code |
| `--wait` with nothing pending | "No login is waiting for approval" | Run step 1 first; `--wait` resumes a request, it does not start one |

## Uninstalling

Remove only the pieces that are actually present — check for each first. If none are present, Patchstack isn't installed; report that and stop. If the user asked to remove only one piece (e.g. "just the widget"), remove only that piece.

1. **Read the site UUID from `.patchstackrc.json` before deleting anything.** It is the only local record of the provisioned site — report it to the user at the end so they can identify the site in their dashboard.
2. **Remove the widget snippets** from the layout/template: the `<script src="https://cdn.patchstack.com/patchstack-widget.js">` tag and any `PatchstackWidget.init(...)` call (which may live in a separate client component/plugin/effect). Afterwards, grep the repo for `patchstack-widget` and `PatchstackWidget` to confirm nothing remains.
3. **Remove runtime protection before uninstalling the package.** Delete the connector-managed guard/rules files and remove only their managed imports, middleware registrations, tunnel code, and `#region patchstack…` blocks from the framework/server files. Preserve unrelated middleware and application code. Run `rg "patchstack|x-ps-target"` (or the available equivalent) afterwards and inspect every remaining source hit.
4. **Remove the hooks from `package.json` scripts.** If a hook was chained (e.g. `"postbuild": "existing-command && patchstack-connect mark-build"`), remove only the `patchstack-connect …` part and keep the rest; if removal leaves a script empty, delete the key.
5. **Signal Patchstack that the package is being removed**: run `npx @patchstack/connect uninstall` (while the package is still installed and `.patchstackrc.json` still exists). If the site was never claimed, this deletes its anonymous record on Patchstack; if the site is claimed, it is only flagged — the record stays until its owner removes it in the dashboard. A failed signal must not stop the uninstall; continue with the remaining steps.
6. **Uninstall the package** with the manager matching the lockfile: `npm uninstall` / `pnpm remove` / `yarn remove` / `bun remove` `@patchstack/connect`. Don't hand-edit `node_modules` or the lockfile.
7. **Delete `.patchstackrc.json` and `.patchstackrc.local.json`** (the second holds the API key and is git-ignored, so it is present locally even when the repo shows nothing), remove the `.gitignore` entry setup added for it, and remove `PATCHSTACK_SITE_UUID`, `PATCHSTACK_API_KEY` (and public-prefixed variants like `NEXT_PUBLIC_PATCHSTACK_SITE_UUID`) from env files and CI variables.
8. **Commit** the changes. Reporting stops immediately. On HTML shells the `window.__PATCHSTACK_PROD__` flag that `mark-build` stamped lives only in build output — the next build simply won't contain it (rebuild if build output is committed). On JSX roots `scan` wrote the same marker into source; remove that managed `#region patchstack` block (or the hand-pasted equivalent) with the widget tag in step 2.

The `uninstall` signal is the only account-side effect local removal can have: it deletes an *unclaimed* (anonymous) record and merely flags a *claimed* one. A claimed site keeps using a site slot until its owner removes it in the dashboard at https://app.patchstack.com — end your report by telling the user this, alongside the site UUID from step 1. Never attempt to authenticate or remove a claimed site on the user's behalf.

The reverse also holds: removing the site on Patchstack's side (dashboard delete or the widget's uninstall flow) does not touch these local files — they must still be removed with the steps above. `npx @patchstack/connect status` shows `Site status: removed from Patchstack` in that state.
