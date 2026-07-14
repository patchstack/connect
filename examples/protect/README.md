# @patchstack/connect/protect — end-to-end demo

Shows the full **Verified Vulnerability Shielding** loop against a **real, unmodified
vulnerable dependency** — no mocks of the vulnerability itself.

```bash
cd examples/protect
npm install      # pulls the real vulnerable lodash@4.17.11 (CVE-2019-10744)
npm run demo
```

Expected: all six steps ✓.

## What it demonstrates

| Step | |
|---|---|
| 1 | The exploit works **unprotected** — `lodash.defaultsDeep` on a `{"constructor":{"prototype":…}}` body pollutes `Object.prototype`. |
| 2 | **dry-run**: the vPatch *detects + logs* the exploit but still serves it (the safe onramp). |
| 3 | **block**: the request is rejected (403) before the vulnerable sink runs — prototype stays clean. |
| 4 | A **benign** request to the same route is still served (no false positive). |
| 5 | A response that accidentally **leaks an AWS key** has it **redacted** (`[REDACTED]`) while the page is still served. |
| 6 | An **outbound SSRF** to cloud metadata (`169.254.169.254`) is blocked; an external call is allowed. |

…and prints the proof line: *"CVE-2019-10744 in lodash@4.17.11 is blocked here, right now,
by rule `demo-CVE-2019-10744` — until you upgrade to 4.17.12. No app redeploy required."*

## Vulnerability gallery (demo-env showcase)

For demonstrating **many** vulnerability classes at once (not one deep CVE proof), there's a
comprehensive demo rule set and a gallery runner — no vulnerable dependency required, so it runs
anywhere with zero install:

```bash
node gallery.mjs          # or: npm run gallery
```

It loads [`demo-rules.json`](./demo-rules.json) and shows, one row per rule, that the exploit is
blocked/redacted while a benign request to the same surface is allowed — across all three phases:

- **request (WAF)** — prototype pollution, path traversal, SQLi, XSS, command injection, NoSQL
  injection, XXE, request-side SSRF
- **response (leak)** — PII redaction (email, credit-card number) on top of the built-in secret
  redaction (private keys, AWS/GCP keys, JWTs, DB URLs, stack traces)
- **egress (SSRF)** — outbound request to a blocklisted exfiltration host

Each rule carries an `_demo` block (exploit + benign vector). The same bundle is asserted in CI by
`tests/protect/demo-rules.test.ts` (every rule must block its exploit and pass its benign) and the
whole `examples/` folder is kept out of the published npm package (`tests/pack-safety.test.ts`), so
the vulnerable `lodash` the deep demo installs never reaches consumers.

## Loading the demo rules on a real Lovable app

`patchstack-connect protect` scaffolds the runtime guard into a TanStack Start + Supabase app and
drops `src/integrations/patchstack/{guard.ts, rules.json}`. That scaffolded `rules.json` is the
**token-less fallback** the guard loads — so it's the insertion point for a demo. Seed it with this
bundle:

```bash
# in the Lovable app
npx patchstack-connect protect                          # scaffold + wire the guard
cp <this-repo>/examples/protect/demo-rules.json \
   src/integrations/patchstack/rules.json               # swap the fallback for the demo set
# leave PATCHSTACK_WAF_TOKEN UNSET so the guard uses the local rules (not the live API)
```

`demo-rules.json` is a drop-in `rules.json` — same `{ firewall, whitelists, whitelist_keys }`
shape; `createProtection` splits the phase-tagged rules and ignores the `_demo` blocks. The guard
blocks by default (`PATCHSTACK_MODE=dry-run` for log-only).

**What fires where** (the guard hooks the *data path*, not arbitrary routes):

- ✅ **prototype pollution / SQLi / XSS / NoSQL injection** in a record you write (e.g. a task
  title) — caught via the Supabase tunnel + server-function arg inspection.
- ✅ **response PII / secret redaction** — masked in Supabase query results the guard forwards.
- ⚠️ **path traversal / command injection / request-side SSRF** target `get.file` / `get.host` /
  `get.url`; they only fire if the app actually has such a route + parameter.
- ⚠️ **egress SSRF** is dormant unless the guard is created with `egress: true` (the scaffolded
  `guard.ts` doesn't enable it by default) — for an egress demo, add `egress: true` to
  `getProtection()` in the scaffolded `guard.ts`.

For a live tasks-app demo, the reliable rows are the write-path ones (insert a task whose title is
`<script>…</script>` → blocked) and the response redaction (store/return a value containing an
email or card number → masked). The full matrix is best shown offline via `gallery.mjs`.

## Note on rules

`rules.demo.json` holds **example rules for public CVEs only** — it is **not** the
Patchstack production corpus. In a real deployment the per-site, version-scoped rule set is
fetched from the Patchstack API (`createProtection({ token })`), cached to disk. The demo
uses a local bundle and **no token / secret**.
