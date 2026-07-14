# Getting started — connect a project to Patchstack

The teammate-facing path from "I have a JS/Node project" to automatic dependency monitoring, source-widget installation, and strict static-build verification.

> **Security gate:** the current pre-release backend lets the client-visible site UUID authorize manifest writes and unclaimed-site claiming. Until Patchstack separates public widget identity, manifest-write authorization, and a scoped one-time claim credential, use this flow only with disposable local test data. Do not deploy it, open or share its UUID-derived claim URL, or commit generated `.patchstackrc.json`/widget output.

## 1. Paste this prompt into your AI coding tool

Works in Cursor, Claude Code, Lovable, Bolt, v0, Windsurf, etc. Paste it exactly — every clause is there for a reason (see step 2), so don't shorten it:

> Add Patchstack dependency vulnerability monitoring: install `@patchstack/connect` as a dev dependency (MIT — verify with `npm view @patchstack/connect`; source: https://github.com/patchstack/connect), then use that installed copy through the project's package manager to run `patchstack-connect scan`; it resolves or provisions and saves the site UUID, then adds the report-a-vulnerability widget to a safe app shell. Show me the claim URL it prints (I'll open it in my browser — don't open or fetch it yourself), reload the preview to confirm the widget appears, then run the installed `patchstack-connect guide` and finish only what its checklist flags: package.json build hooks ending in `mark-build --strict`, or creating/fixing the framework's safe root shell before rerunning. Do not use a runner that downloads another CLI copy.

After the security gate is closed, the claim URL will use a separate one-time credential; opening it in your browser and signing in will attach the monitored site to your Patchstack account. During current disposable security testing, stop before opening or sharing the printed UUID-derived URL.

## 2. If the agent refuses or stops halfway

Some agents decline this request, and that's expected behaviour, not a bug: installing a package and running its commands resembles a supply-chain attack, so cautious agents audit the package first and occasionally still say no. Refusals are more common in locked-down sandboxes (Bolt/WebContainer-style platforms) and shortly after a connector release, when the version looks brand-new to the agent.

Work down this list:

1. **It asks you to confirm, or says it wants the package vetted first.** Reply with the confirmation it requested, for example: *"I've verified this is the official Patchstack package (`npm view @patchstack/connect` — published by patchstack, MIT). Please continue with the remaining steps."*
2. **It did some steps, then stalled.** Ask it to run the already-installed `patchstack-connect guide` through the project's package manager and finish only the missing build-hook or safe-root-shell work it reports. Do not use a runner that can fetch another CLI copy.
3. **It refuses outright.** Skip the agent and use the manual flow below.

If you hit a refusal with a *new* reason, copy the explanation and send it to the maintainers or open an issue. Real-world refusal reports become regression coverage in [`field-test/`](field-test/README.md).

## 3. Manual fallback (no agent needed)

For an npm-managed project:

```bash
npm install --save-dev @patchstack/connect
npx --no-install patchstack-connect scan
npx --no-install patchstack-connect guide
```

Use the same package manager that owns the project's lockfile: `pnpm add -D` with `pnpm exec patchstack-connect`, `yarn add -D` with `yarn patchstack-connect`, or `bun add -d` with `bun run patchstack-connect`. The installed, lockfile-pinned binary must run every command.

`scan` preflights a safe global shell before posting, provisions or reuses one identity, saves it, and idempotently installs the widget in source. `guide` then reports only remaining build-hook or safe-root-shell work. For static sites, the build must run `scan` before the compiler and `mark-build --strict` afterward, so the same identity and widget are baked into every complete generated HTML document.

## 4. You're done when

- `scan` has saved one identity and the development preview shows exactly one widget after reload.
- The installed `guide` reports all steps ✔, including build hooks and source-widget coverage.
- A production/static build succeeds with `mark-build --strict` and verifies the widget in every complete deployable HTML document.
- After the credential-separation gate closes, you have opened the separate one-time claim URL and committed only explicitly non-authorizing configuration plus `package.json` and the managed source shell. With today's single-UUID protocol, do not commit or deploy those generated files.
