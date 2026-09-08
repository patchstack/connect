# @patchstack/connect/protect — end-to-end demo

Shows the full **Verified Vulnerability Shielding** loop against a **real, unmodified
vulnerable dependency** — no mocks of the vulnerability itself.

```bash
# From the repository root: the demos load the built runtime, which is what an application loads.
npm install
npm run build

cd examples/protect
npm run setup    # installs lodash@4.17.11 (CVE-2019-10744), the vulnerable target
npm run demo
```

Expected: all six steps ✓.

The vulnerable target is installed by `npm run setup` rather than declared as a dependency of this
example, so that a knowingly vulnerable package stays out of the repository's dependency graph. The
version lives in `demo-target.mjs`; the demos refuse to run against any other.

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

## Delivery + promotion chain (rule served by Pulse)

`demo.mjs` wires the rule from a local file. To show the **real delivery path the pilot uses** —
the rule served by Pulse over HTTP, fetched by the guard's own Pulse client, then **promoted from
dry-run to block *remotely*** (Pulse flips the bundle's `enforcement`; the guard hot-swaps on
refresh, no redeploy):

```bash
npm run demo:pulse
```

It stands up a mock Pulse rules endpoint (local loopback) and walks the chain end to end:

| Step | |
|---|---|
| 1 | The rule is **fetched from Pulse over HTTP** by site UUID (not a local file). |
| 2 | The guard adopts Pulse's `enforcement: dry-run` — the exploit is **detected + logged but served**. |
| 3 | Pulse flips the bundle to `enforcement: block` (new ETag); a **refresh hot-swaps** the guard — no redeploy. |
| 4 | The **same exploit** is now **blocked (403)**; the sink never runs; a benign request still returns 200. |
| 5 | A refresh with no change **revalidates as `304 Not Modified`** (conditional fetch, no body re-sent). |

This is the static-rule delivery + remote-promotion chain the pilot ships on; the promotion seam
is what the observed→enforced auto-promote flow builds on. Guarded in CI by
[`tests/protect/pulse-chain.test.ts`](../../tests/protect/pulse-chain.test.ts).

## Vulnerability gallery (demo-env showcase)

For demonstrating **many** vulnerability classes at once (not one deep CVE proof), there's a
comprehensive demo rule set and a gallery runner. It needs no vulnerable dependency — so once the
repository is built, `npm run setup` is not required for this one:

```bash
# From the repository root, if you have not built yet:
npm install && npm run build

cd examples/protect
npm run gallery           # or: node gallery.mjs
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
- ✅ **egress SSRF** — the scaffolded `guard.ts` enables `egress: true`, so the app's outbound
  calls to internal / cloud-metadata addresses are blocked (its own Supabase project is allowed).
- ⚠️ **path traversal / command injection / request-side SSRF** target `get.file` / `get.host` /
  `get.url`; they only fire if the app actually has such a route + parameter.

For a live tasks-app demo, the reliable rows are the write-path ones (insert a task whose title is
`<script>…</script>` → blocked) and the response redaction (store/return a value containing an
email or card number → masked). The full matrix is best shown offline via `gallery.mjs`.

## Note on rules

`rules.demo.json` holds **example rules for public CVEs only** — it is **not** the
Patchstack production corpus. In a real deployment the per-site, version-scoped rule set is
fetched from the Patchstack API (`createProtection({ token })`), cached to disk. The demo
uses a local bundle and **no token / secret**.
