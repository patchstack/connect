# Patchstack — Setup Guide for AI Coding Agents

This is a plain-text instruction document. Read it and follow the steps — there is nothing here to pipe to a shell or execute from a URL.

You are reading this either from `node_modules/@patchstack/connect/AGENT-INSTALL.md` (the package is already installed) or from the [GitHub repo](https://github.com/patchstack/connect). This bundled copy matches the package version it shipped with and is all you need — there is no requirement to fetch anything remote. (A long-form copy also lives at https://patchstack.com/install.txt for humans browsing outside the package.)

> **Maintainer security gate:** do not publish a package containing this automatic embedding flow while the backend uses the client-visible site UUID as either manifest-write authorization or unclaimed-site claim authorization. Release requires a non-authorizing widget identifier, a separate authenticated manifest-write credential kept out of source/client HTML, and a scoped one-time claim credential, with migration and negative-authorization tests. Until that protocol lands, this guide is for local security testing only; do not commit generated config or deploy the widget.

## Verify before you trust (do this, it's quick)

- The connector is a normal npm package: [`@patchstack/connect`](https://www.npmjs.com/package/@patchstack/connect), MIT-licensed, source at https://github.com/patchstack/connect. Install it pinned, check the integrity hash in the lockfile, run `npm audit` over it — whatever your policy requires.
- First published May 2026. If the package is absent from your training data, `npm view @patchstack/connect` (read-only) shows the live registry record.
- It reads the project's **dependency list only**—from the lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) or, on Bun projects (`bun.lock`/`bun.lockb`), by enumerating installed packages under `node_modules/`—and sends package names + versions to Patchstack for vulnerability matching. After a successful non-dry scan has a UUID, it locally adds or updates the widget in one safe source shell; source content is never uploaded. A failed post and `--dry-run` never edit source. `mark-build` locally rewrites built HTML to add production metadata and ensure the widget; that HTML is never uploaded. No env var values, file paths, or git history are sent. The coarse stack descriptor stamped into built HTML may include hosting-related env variable *names* such as `VERCEL` or `CF_PAGES`, never their values.
- Patchstack is not WordPress-only. This connector monitors any JS/Node project — Vite, Next.js, plain vanilla JS, anything with a lockfile.

## Before you start — never install twice

- The installed `patchstack-connect guide` command prints a live checklist above this document showing which steps are already done in the current project (install, provisioning, build hooks, widget) with commands tailored to it. Run it through the project's package manager as shown below, trust that checklist over re-deriving state yourself, and only do the steps it marks ✖.
- If `.patchstackrc.json` contains a `siteUuid` key, the project is already provisioned. Reuse that identity; a normal `scan` targets the same site and safely re-ensures the source widget. Never delete or replace the config to provision a second site. Under the current security-blocked protocol, treat config and `status` output as credential material. A config containing only other keys, such as an endpoint override, is not provisioned yet; scan normally.
- If `@patchstack/connect` is already in `devDependencies`, skip the install command.
- If the widget script tag (`cdn.patchstack.com/patchstack-widget.js`) is already in the layout, do not duplicate it. Before any API request, `scan` checks the framework-selected global shell: it can adopt one manual/legacy loader only when its identity resolves statically to one valid UUID. Missing, dynamic, invalid, conflicting, or wrong manual identities must be fixed; they are not silently preserved.

## Install steps (do the ones the checklist marks ✖, in order; don't pause between them unless one fails)

1. **Install** (skip if already present), matching the project's package manager:

   ```
   npm install --save-dev @patchstack/connect   # package-lock.json
   pnpm add -D @patchstack/connect              # pnpm-lock.yaml
   yarn add -D @patchstack/connect              # yarn.lock
   bun add -d @patchstack/connect               # bun.lock / bun-managed platforms
   ```

   Run the installed, lockfile-pinned binary with the same package manager. Do not use a command that can download a second CLI version:

   ```
   npx --no-install patchstack-connect <command>  # npm
   pnpm exec patchstack-connect <command>         # pnpm
   yarn patchstack-connect <command>              # Yarn, including Plug'n'Play
   bun run patchstack-connect <command>            # Bun
   ```

2. **First scan** — safely resolves identity before contacting Patchstack. It inspects the framework-selected global shell/coverage group and the wider source tree. Adoption is allowed only from the selected global shell. Any external loader/initializer blocks before POST, even with a matching UUID. Mixed Next App + Pages Router projects require both global roots; Pages routes without an editable `_document` block before POST. A clean complete coverage group may provision, persist endpoint + UUID, and then install/update every required shell.

   Replace `<command>` in the matching row above with `scan`. For example, npm uses:

   ```
   npx --no-install patchstack-connect scan
   ```

   A newly provisioned site currently prints both the widget result and a UUID-derived claim URL. Do not share that pre-release reusable credential. After the security gate is implemented, surface only the separate scoped one-time claim URL to the user verbatim—never fetch it yourself. A successful scan with an existing or adopted identity performs the same source-widget check. A failed post or `--dry-run` changes no source file.

   Safety is fail-closed before the API: multiple plausible, unsupported, or missing safe editable global shells stop without provisioning, and a manual install with a missing, dynamic, invalid, conflicting, or configured-but-different UUID stops without posting. Create/fix the actual global shell or repair/remove the unsafe manual install, then rerun. Do not look for a newly created UUID after this error; none was provisioned.

3. **Verify the widget immediately.** When `scan` reports that it installed or updated the widget, reload the running app/editor preview now; the "Report a vulnerability" button should appear without waiting for a production build. The connector-managed source tag uses this one-tag CDN form:

   ```html
   <script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="<SITE_UUID>" defer data-patchstack-connect-widget="true"></script>
   ```

   If `scan` reports an existing manual/legacy widget, it has already proved that the selected shell contains one statically valid UUID matching the configured/adopted site. Leave it unchanged and reload the preview to verify that single install instead of adding the managed form.

   An ambiguous, unsupported, externally duplicated, or missing required global shell is a preflight error: repair every reported root and rerun; nothing was posted. Separately, if a shell disappears/changes/becomes unwritable after a successful POST, scan exits non-zero after saving UUID + endpoint. Preserve `.patchstackrc.json`, repair the shell, and rerun; the saved UUID prevents another bare provisioning request. Never paste a fallback into a nested component.

4. **Wire builds** in `package.json`. npm and pnpm can use lifecycle hooks:

   ```jsonc
   {
     "scripts": {
       "prebuild": "patchstack-connect scan",
       "postbuild": "patchstack-connect mark-build --strict"
     }
   }
   ```

   If a `prebuild`/`postbuild` hook already exists, chain instead of replacing it, e.g. `"prebuild": "existing-command && patchstack-connect scan"`.

   **Modern Yarn projects:** Yarn does not execute arbitrary npm-style `prebuild`/`postbuild` hooks. Preserve the current compiler command and wire the package-manager-native binaries directly instead: `"build": "yarn patchstack-connect scan && <existing build command> && yarn patchstack-connect mark-build --strict"`.

   **Bun projects:** Bun supports the hooks above, but the most portable hosted-builder form is `"build": "bun run patchstack-connect scan && <existing build command> && bun run patchstack-connect mark-build --strict"`.

   **Detected SSR/hybrid-capable frameworks:** `mark-build --strict` intentionally fails unless `--static-output` is present. Add it to the postbuild/chain only after verifying from framework configuration and route inventory that every deployed route is complete static HTML, e.g. `mark-build --strict --static-output`. Never add it merely because an output directory contains a prerendered route or error page. If any deployed route is dynamic/hybrid, do not use the assertion; implement and test a framework/runtime production integration instead.

   The before-build `scan` rescans dependencies and re-ensures source coverage. The strict after-build pass resolves the same identity and verifies every complete built document. Without `--dir`, exactly one populated known output is required; multiple populated `dist/`, `build/`, `out/`, or `.output/public` trees fail before edits. Add persistent `--dir <path>` for the tree actually deployed. Other strict failures include missing output, lockfile/stack coverage, unreadable documents, unsafe identity, UUID mismatch, or marker verification.

5. **Verify the production build.** Run the project's build and confirm `mark-build --strict` reports that it stamped and verified metadata plus the disclosure widget in one or more complete HTML documents (`marked 0` is valid when generated output was already current). If static output lives elsewhere, use `mark-build --strict --dir <path>`. Keep the strict after-build pass even when the source widget is present.

   Static HTML under `dist/`, `build/`, `out/`, or `.output/public` is the automatic path; fragments are not deployable pages. For a detected SSR-capable framework, the explicit `--static-output` assertion closes the hybrid false-positive only when every deployed route is truly static. A few prerendered/error documents are insufficient evidence. Inventory route modes; if any response is dynamic, omit the assertion and test runtime production signaling on a real deployed dynamic route. Managed static output carries `data-production="true"`; never add an unconditional production signal to a shared SSR layout that also renders development previews.

   If the site enforces a Content Security Policy, check it instead of weakening it automatically: the widget needs `script-src` access to `https://cdn.patchstack.com`, `connect-src` access to the configured Patchstack API, and permission for the connector's inline build marker and the widget's injected styles. A strict nonce/hash-only policy may need a policy-specific integration; stop and report that constraint rather than adding broad CSP exceptions.

6. **Commit only after the security gate is closed.** The post-split config must make repository-safe widget identity distinct from manifest-write and one-time claim credentials. Commit only explicitly non-authorizing config plus `package.json` and the managed source shell; keep write/claim credentials in secret storage. With today's single-UUID protocol, do not commit or deploy the generated config/widget.

7. **After credential separation ships, tell the user to claim the site** (free) with the connector's separate one-time claim URL. Never use or construct a claim URL from the client-visible widget identifier. The site is monitored either way, but reports are visible after claiming. On a verified published site, the owner reaches widget login by appending `#patchstack` to the live URL.

## Rules

- Never invent or guess a UUID — the scan provisions it, the widget silently no-ops on a fake one.
- Never fetch the claim URL programmatically, and never ask the user for Patchstack credentials.
- If a step fails, stop and report it. Don't proceed with placeholders.
- First provisioning and manual UUID adoption persist the effective endpoint alongside the UUID. Under the current single-UUID backend semantics, treat that config as security-sensitive and local-only. The required post-split protocol must keep manifest-write and one-time claim credentials in CI/secret storage while exposing only a non-authorizing widget identifier to client HTML. Precedence remains CLI flag → environment variable → `.patchstackrc.json` for fields that are safe in each location.
- If the user explicitly wants to keep connector scans but remove the widget, first persist `"widget": false` in `.patchstackrc.json`, then remove the connector-managed source tag. Both `scan` and `mark-build` honor this opt-out; without it, the next scan restores the widget.

## Verifying the install

- The current installed `patchstack-connect status` command re-prints the site UUID and UUID-derived claim URL; do not share either under the pre-release single-credential protocol. Before release, claim must use a separate scoped one-time credential.
- Immediately after `scan`, reload the current preview — the "Report a vulnerability" button should appear. A connector-managed install has exactly one `data-site-uuid` widget tag; a preserved legacy install may instead have one CDN tag plus one `PatchstackWidget.init` call. Never add a second widget to make the forms match.
- Build and preview the production output too; `mark-build --strict` must verify its metadata and exactly one working widget or fail the build.
