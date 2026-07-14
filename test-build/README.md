# test-build — see the hooks work on a real example site

A one-command, end-to-end check of the `prebuild`/`postbuild` flow on a small
static Node.js site, without touching the real Patchstack API. It exists so a
change to `scan`'s widget injection or `mark-build`'s stamping can be verified
in a browser in under a minute.

From this folder, run the complete automated test with one command:

```bash
npm test
```

To run the same checks and then serve the example site at
<http://localhost:4173>:

```bash
npm start
```

Both commands build the local connector first, so no preparation from the
repository root is needed.

What one run does:

1. Copies `site/` into `test-build/.work/` — a throwaway fixture, recreated on
   every run, so the repo itself is never edited.
2. Starts the mocked Patchstack API from `field-test/mock-api.mjs`. Nothing
   leaves the machine; no real site is provisioned.
3. Runs `npm run build` inside the fixture — the real npm hook mechanism:
   - `prebuild` → `scan`: posts the fixture lockfile to the mock, persists the
     mock UUID to `.patchstackrc.json`, and injects the managed widget tag into
     the fixture's `index.html`.
   - `build` → copies the site into `dist/`.
   - `postbuild` → `mark-build`: stamps `dist/` HTML with the production flag +
     build fingerprint and verifies the widget tag came through.
4. Prints a ✔/✖ checklist (source tag, exactly one tag in output, prod flag,
   fingerprint, manifest POST) and exits non-zero if anything failed.
5. Serves `dist/` on <http://localhost:4173> so you can see the widget button.

## Advanced usage

- `node run.mjs --no-serve` — build + verify without rebuilding the connector.
- `--widget-js <path>` — serve a local widget bundle instead of the CDN copy,
  e.g. `node run.mjs --widget-js ../../sass-webvdp-widget/dist/patchstack-widget.js`,
  to test unreleased widget builds against the connector flow.

## Notes

- The page loads the widget from `https://cdn.patchstack.com` unless
  `--widget-js` is given, so seeing the button needs network access.
- The served build carries the production flag, so the widget shows the
  report-only UI; append `#patchstack` to the URL for the owner login flow.
- This harness tests the local `dist/cli.js` — unlike `field-test/`, which
  installs the *published* package and exercises the AI-agent install prompt.
