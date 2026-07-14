# Patchstack connector test app

`testConnect/` is a maintained, deliberately small Vite application for testing the local connector end to end. It proves that one UUID moves through the complete flow:

1. `scan` adopts or provisions the UUID and injects the CDN widget into source.
2. The development preview shows the widget immediately.
3. Vite compiles a real static `dist/index.html`.
4. `mark-build --strict` stamps production state and verifies the same UUID in the output.

The fixture depends on the parent checkout through `file:..`. Vite 6 keeps it compatible with the connector's Node 18+ support. The repository tracks `index.template.html`; `npm install` copies it to an ignored `index.html`, so a scan can exercise a real source edit without making the credential-bearing result eligible for a normal `git add .`.

Security warning: under the current pre-release backend semantics, the site UUID also authorizes manifest writes and unclaimed-site claiming, while the widget embeds it in HTML. Treat every generated UUID as disposable local security-test data: do not publish this app or commit/share `.patchstackrc.json`, its claim URL, or generated HTML. The automatic embedding release is blocked until the backend and connector separate public widget identity, manifest-write credentials, and one-time claim credentials.

## 1. Install dependencies

```bash
cd /path/to/connect
npm install
npm run build
cd testConnect
npm install
```

The parent build only compiles the connector. Installing this fixture prepares the ignored working `index.html` but does not provision anything or contact Patchstack. Generated source, dependencies, static output, browser screenshots, and `.patchstackrc.json` are intentionally ignored.

## 2. Start the source preview

```bash
npm run dev
```

Open the printed `http://127.0.0.1:5173` address. At this point the generated test page works but the Patchstack widget has not been installed.

## 3. Get the UUID and install the widget

In another terminal, from the same directory:

```bash
npm run patchstack:scan
```

This is a real API scan. It first verifies that the ignored generated `index.html` is the one safe editable global shell. It then reuses a configured UUID, adopts one safe existing widget UUID, or provisions a test site. The connector persists the current security-sensitive UUID and issuing endpoint in `.patchstackrc.json`, then inserts that UUID into one managed CDN tag in `index.html`.

If source preflight fails, no manifest is posted and no UUID is provisioned. A newly provisioned site also prints the current UUID-derived claim URL; do not open, publish, commit, or share it.

Inspect the result:

```bash
cat .patchstackrc.json
rg -n "patchstack|data-site-uuid" index.html
```

Reload the development preview. The connect/disclosure widget must now be visible without waiting for a production build.

## 4. Test the complete static build lifecycle

```bash
npm run build
```

This deliberately runs three commands in sequence:

1. `prebuild` runs `patchstack-connect scan` and waits for the UUID/source tag.
2. Vite compiles the website to `dist/`.
3. `postbuild` runs `patchstack-connect mark-build --strict` over the generated HTML and fails the build unless the complete static page has valid production metadata and exactly one widget using the saved UUID.

Verify that source and static output use the same UUID and contain only one managed widget:

```bash
rg -n "patchstack|data-site-uuid|__PATCHSTACK" index.html dist/index.html .patchstackrc.json
```

## 5. Preview the static output

```bash
npm run preview
```

Open the printed `http://127.0.0.1:4173` address. You are now viewing the generated static files, not Vite's source-development mode.

You can re-run `npm run build` to confirm the process is idempotent: it should keep exactly one widget tag, and strict verification must pass. `npm run patchstack:status` reprints the current security-sensitive UUID/endpoint/claim URL; use it only locally and never copy its output into chat, logs, commits, or screenshots.

After one successful scan has saved a UUID, `npm run build:static` rebuilds and strictly verifies the static output without another API scan. The normal `npm run build` intentionally exercises the complete `prebuild` → compiler → `postbuild` lifecycle and therefore reports to the Patchstack API.

## Resetting the generated source

The repository keeps this test app, so do not delete the directory. Reset only the ignored generated source with:

```bash
npm run fixture:reset-source
```

This deliberately keeps `.patchstackrc.json`, so the next scan reuses the same site instead of provisioning a duplicate. The generated source, config, and `dist/` are ignored, but still run `git status --short --ignored .` from this directory before sharing or committing test artifacts.

To exercise a genuinely new provisioning flow, first revoke/delete the old site or credential. Delete a claimed test site privately in the dashboard; for an unclaimed site, ask the backend owner/support to delete or expire it. Only after that remote cleanup should you remove `.patchstackrc.json`, reset the source, and scan again. Deleting local config alone neither revokes the old site nor prevents an orphan/duplicate.

Do not use this fixture as a production starter. It is intentionally small and its normal `npm run build` performs a real manifest POST so the complete lifecycle remains testable.
