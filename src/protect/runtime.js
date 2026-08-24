// @patchstack/protect — "Protect = respond".
//
// One entry point that composes the node-waf engine + adapters with:
//   - a rule source: an explicit bundle, or fetched from the Patchstack API (token),
//     with a disk cache so the engine keeps working on last-known-good if the API is down
//   - execution modes: 'dry-run' (detect + log, never block — the safe onramp) and 'block' (enforce).
//     This API's default is 'dry-run'. NOTE the scaffolded guard (`patchstack-connect protect`)
//     deliberately passes mode: 'block' and only drops to dry-run when PATCHSTACK_MODE=dry-run — so an
//     installed guard ENFORCES by default even though this constructor's default doesn't. Precedence:
//     PATCHSTACK_MODE env > API `enforcement` > options.mode > dry-run.
//   - fail-open everywhere: a rule/engine error never blocks (or crashes) a request. Where the guard
//     fails open *without* inspecting (body caps, live streams, binary bodies, resolver failures) it
//     is counted and reported — see `protection.coverage()` / the `onSkip` option.
//
// Runtime guards: .express(), .node(), .fetch(handler) / .fetchGuard() — same policy,
// every runtime an AI builder deploys to.
// Vendored node-waf engine (this package is self-contained — no @patchstack/node-waf dep).
import { RuleEngine } from './engine/index.js';
import { matchValue, walkLeaves, safeRegExp } from './engine/engine.js';
import { PulseRuleClient } from './engine/pulse-client.js';
import { fromFetchRequest } from './engine/fetch.js';
import { fromNodeRequest } from './engine/node.js';
import { installEgressGuard } from './egress.js';
import { DEFAULT_RESPONSE_RULES, DEFAULT_EGRESS_RULES } from './defaults.js';
import { renderBlockPage } from './block-page.js';
// Rule lifecycle (source / tiered store / refresh) lives in ./rules/ — this file stays focused on
// composing the engine + guards and running the three screening phases.
import { makeStore } from './rules/store.js';
import { resolveRules } from './rules/source.js';
import { startRefresh, makeRefreshHandler } from './rules/refresh.js';
import { createDetectionReporter } from './detections.js';
import { notify } from './notify.js';
import { createFirewallLogReporter, resolveApiBase, telemetryEnabled } from './firewall-log.js';

// Supabase-tunnel guard for AI-builder apps (Lovable / TanStack Start + Supabase).
export { createSupabaseGuard, GUARD_PATH } from './supabase-guard.js';

// Per-site live rule client (Pulse). Re-exported for callers/tests that want to use it directly.
export { PulseRuleClient };

// Server-function guard. Modern Lovable apps mutate data through TanStack server functions
// (browser → server fn → server-side Supabase client), which bypass the browser-side tunnel the
// Supabase guard relies on. This inspects the decoded server-fn call args against the SAME policy
// by feeding them through fetchGuard (the args become the request body, so the engine resolves
// `post.<field>` exactly as it does for a tunneled Supabase insert). Returns a block receipt
// { rule?, message } to throw on, or null to allow (also null in dry-run — the detection is still
// recorded by fetchGuard). Fail-open on any error.
export function createServerFnGuard({ protection }) {
  const guard = protection.fetchGuard();
  return async (data) => {
    let res;
    try {
      const req = new Request('https://patchstack.local/_serverfn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data ?? {}),
      });
      res = await guard(req);
    } catch {
      return null; // fail open
    }
    if (!res) return null; // allowed (or dry-run)
    let body = {};
    try {
      body = await res.clone().json();
    } catch {
      /* non-JSON block response */
    }
    return { rule: body.rule, message: body.message || 'Blocked by Patchstack' };
  };
}

export async function createProtection(options = {}) {
  const onError = options.onError;
  const userOnDetect = options.onDetect ?? defaultOnDetect;

  // Report enforced blocks via existing connector POST /api/logs/log (WP path).
  // Needs api_key from provision / PATCHSTACK_API_KEY / .patchstackrc.json.
  // Opt out: PATCHSTACK_TELEMETRY=off. Never embed api_key in the public widget.
  const apiKey = await resolveApiKey(options);
  const firewallLog =
    apiKey && telemetryEnabled() && options.reportFirewallLog !== false
      ? createFirewallLogReporter({
          apiKey,
          apiBase: resolveApiBase(options.pulseRulesUrl ?? options.baseUrl),
          sourceHost: options.sourceHost,
          fetchImpl: options.fetchImpl,
        })
      : null;

  // Every detection, enforced or not, to the Pulse detections endpoint. Distinct from the block log
  // above: that records what was STOPPED, in the WordPress-compatible shape; this records what a rule
  // WOULD have stopped, which is otherwise unobservable for a rule carrying `enforcement: dry-run`.
  // Minimal payload by design; see `detections.js`.
  let detections = null;

  const onDetect = (detection) => {
    notify(userOnDetect, detection, 'onDetect');
    if (detections) detections.record(detection);
    if (firewallLog && detection?.mode === 'block') {
      firewallLog.record({
        rule: detection.rule,
        method: detection.method,
        path: detection.path,
        ip: detection.ip,
        userAgent: detection.userAgent,
      });
    }
  };

  // One tiered store (memory → filesystem/pluggable) shared by the initial load and every refresh.
  const store = makeStore(options);
  // Startup must not hang on the network: hosted platforms (Replit et al.) fail a deploy whose health
  // check is slow, and the guard can always boot from last-known-good / the bundled fallback. Refreshes
  // keep the full budget. Override with { bootTimeoutMs }.
  const bootTimeoutMs = Number(options.bootTimeoutMs) > 0 ? Number(options.bootTimeoutMs) : 5_000;
  // Resolved once and threaded through ctx: reading it is a filesystem hit on
  // runtimes that have one, and refreshes should not repeat it.
  const pulseAuth = await resolvePulseAuth(options);
  // A site UUID with no credential behind it, said out loud ONCE at boot.
  //
  // Resolution reads `.patchstackrc.json`, so it needs a filesystem and a working directory. The
  // runtimes this guard is built for do not all have one: on a Worker or an edge function the file is
  // absent and only `PATCHSTACK_PULSE_AUTH` / `PATCHSTACK_API_KEY` can carry the credential.
  //
  // Every site-addressed Pulse endpoint requires a verified, site-bound credential; only a first-time
  // provisioning call is anonymous. So a missing credential is not a future problem — the rules fetch is
  // refused now. And the refusal is invisible, because a failed fetch fails open onto the cached or
  // bundled bundle: the guard then screens every request, reports healthy, and never receives another
  // rule. That silence is the whole problem — an app protected by rules frozen at install time looks
  // exactly like an app protected by current ones.
  //
  // A warning, not a throw. Booting is protection; refusing to boot over a missing credential would
  // trade a stale rule set for no rule set at all.
  if (options.siteUuid && !pulseAuth) {
    const message =
      'Patchstack: no API credential resolved for site ' +
      options.siteUuid +
      '. Rule updates will be rejected and this guard would keep running on its cached rules. ' +
      'Set PATCHSTACK_API_KEY (or pass { pulseAuth }) — required on runtimes without a filesystem.';
    notify(onError, new Error(message), 'onError');
    console.warn(message);
  }
  const bundle = await resolveRules(options, store, { timeoutMs: bootTimeoutMs, pulseAuth });
  // OPT-IN, deliberately. Two reasons, and the first is not about privacy: switching it on adds an
  // outbound POST to every guard that has a site UUID, which is a change in what an installed app does
  // on the network — the kind of thing that must be disclosed in the shipped docs before it is a default,
  // not after. The second is that the default belongs to whoever owns that disclosure, so the capability
  // lands here and the flip is a separate, deliberate change.
  //
  // And it needs a credential. The detections endpoint is site-addressed and site-bound-token-only, so a
  // reporter built without one queues events, posts them, and is refused — spending an outbound request
  // per batch to accomplish nothing, while `reportDetections: true` in the config says reporting is on.
  // Refusing to build it is the honest outcome; `protection.detectionReporting` says which it is.
  let detectionReporting = 'off';
  if (options.reportDetections === true && options.siteUuid && telemetryEnabled()) {
    if (!pulseAuth) {
      detectionReporting = 'unavailable-no-credential';
      const message =
        'Patchstack: detection reporting is enabled for site ' +
        options.siteUuid +
        ' but no API credential resolved, so no report could be delivered. Reporting is off.';
      notify(onError, new Error(message), 'onError');
      console.warn(message);
    } else {
      detectionReporting = 'on';
      detections = createDetectionReporter({
        siteUuid: options.siteUuid,
        baseUrl: options.pulseRulesUrl,
        pulseAuth,
        // The bundle the guard is actually running, so a hit can be attributed to the rules that produced
        // it rather than to whatever is current when the report is read. Kept current across refreshes —
        // see the refresh tick below.
        rulesEtag: (await store.read())?.etag ?? null,
        fetchImpl: options.fetchImpl,
        flushMs: options.detectionFlushMs,
      });
    }
  }
  // Mode is mutable so a Pulse refresh can flip dry-run ↔ block when SaaS enables production.
  // Precedence: PATCHSTACK_MODE env (local override) > API enforcement > options.mode > dry-run.
  let mode = resolveMode(options, bundle);
  // Rule-derived runtime state. Held in `let` bindings the guard methods below close over, so a
  // refresh (see the loop near the end) can hot-swap the engines by reassigning them — the
  // egress interception and the protection object itself stay in place, no re-install.
  let requestRules;
  let responseRules;
  let egressRules;
  let screenCap; // max body we'll buffer/screen (rules can raise it)
  let engine;
  let responseRuleSet;
  let egressEngine;

  // Split the delivered ruleset by phase (default "request"), merging phase defaults +
  // per-call overrides. Detection is fully rule-driven — nothing hardcoded.
  const applyBundle = (delivered) => {
    const incoming = delivered.firewall ?? [];
    requestRules = byPhase(incoming, 'request');
    responseRules = [...(options.responseRules ?? DEFAULT_RESPONSE_RULES), ...byPhase(incoming, 'response')];
    screenCap = responseScreenCap(responseRules);
    egressRules = [...(options.egressRules ?? DEFAULT_EGRESS_RULES), ...byPhase(incoming, 'egress')];
    engine = new RuleEngine({
      firewall: requestRules,
      whitelists: delivered.whitelists,
      whitelist_keys: delivered.whitelist_keys,
      onError,
    });
    // One engine per response rule so we can find ALL matches (to redact each). `action:
    // "redact"` masks the offending span(s); anything else withholds the whole response.
    responseRuleSet = responseRules.map((rule) => ({
      rule,
      engine: new RuleEngine({ firewall: [rule], onError }),
      redactors: rule.action === 'redact' || rule.action === 'encode' ? extractRedactors(rule) : null,
      // A redact/encode condition that carries body-transforming mutations (base64_decode, urldecode,
      // json_decode, …) detects on the DECODED body but the span redactors run on the RAW body — so
      // they mask nothing and the secret is served while the log says "redacted". Flag it so screenText
      // fails such a rule CLOSED (block) instead of serving a no-op redaction.
      mutatedSpan: (rule.action === 'redact' || rule.action === 'encode') && hasSpanMutations(rule),
      // Optional cheap pre-filter: literal anchor(s) that MUST appear for the (expensive) regex to
      // have any chance of matching. Lets screenText skip the full scan on bodies with no candidate —
      // the common case — cutting CPU/latency and shrinking the regex/ReDoS surface. Case-insensitive.
      prefilter: Array.isArray(rule.prefilter) && rule.prefilter.length
        ? rule.prefilter.map((s) => String(s).toLowerCase())
        : null,
    }));
    egressEngine = new RuleEngine({ firewall: egressRules, onError });
  };

  applyBundle(bundle);

  // Fail-open COVERAGE. The guard deliberately passes traffic through rather than risk breaking the
  // app: an oversized request body, a response past the screening cap, a live stream, a binary body, a
  // parse failure, a DNS resolver failure. Each of those is a real hole in enforcement, and until now
  // it was SILENT — "always-on" read as "always inspected". Every such bypass is now counted and
  // reported to `onSkip`, so a host can alert on it and `protection.coverage()` can be surfaced.
  // `onSkip` is a TRUSTED SERVER callback: `detail` carries operational context (sizes, statuses,
  // outbound hostnames) for logging/alerting. Do not forward it to a client response.
  const skipCounts = Object.create(null);
  const onSkip = typeof options.onSkip === 'function' ? options.onSkip : null;
  const recordSkip = (phase, reason, detail) => {
    const key = `${phase}:${reason}`;
    skipCounts[key] = (skipCounts[key] ?? 0) + 1;
    // A reporting callback must never affect request handling — including an async one, whose rejection
    // lands after a try/catch here would have returned.
    notify(onSkip, { phase, reason, detail, count: skipCounts[key] }, 'onSkip');
  };

  const maskFn =
    typeof options.maskWith === 'function'
      ? options.maskWith
      : () => (typeof options.maskWith === 'string' ? options.maskWith : '[REDACTED]');

  // Given a request/egress result, enforce (block mode) or just record (dry-run).
  //
  // A rule may carry its own `enforcement: 'dry-run'`, which wins over block mode for that rule alone.
  // Auto-generated rules arrive that way: their coordinate comes from best-effort static analysis, so they
  // are served to detect until a probe or a human has justified them, WITHOUT holding back the
  // hand-authored rules on the same site. A rule with no `enforcement` follows the bundle exactly as
  // before, so an older server that never sends the field behaves identically.
  const ruleMode = (rule) => (rule?.enforcement === 'dry-run' ? 'dry-run' : mode);

  const decide = (phase, result, block, allow, ctx = {}) => {
    if (!result || !result.blocked) return allow();
    const effectiveMode = ruleMode(result.rule);
    onDetect({
      phase,
      // The mode this detection was actually handled under, not the site's: a consumer counting blocks
      // would otherwise over-report, and the whole point of a dry-run rule is that it did not block.
      mode: effectiveMode,
      category: result.rule?.category,
      rule: result.rule,
      message: result.message,
      method: ctx.method,
      path: ctx.path,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return effectiveMode === 'block' ? block() : allow();
  };

  // Response phase core: screen a text body → { verdict: 'pass'|'block'|'redact', body? }.
  // redact masks matched spans; block withholds; block wins over redact. Enforcement only in
  // block mode (dry-run records via onDetect but returns 'pass').
  const screenText = (text, meta, reqCtx) => {
    let blockRule = null;
    const redactions = [];
    const headerMutations = [];
    let lowerText = null; // lazily lowercased body, only if a rule uses a prefilter
    for (const { rule, engine: re, redactors, prefilter, mutatedSpan } of responseRuleSet) {
      // Cheap pre-filter: if none of the rule's literal anchors is in the body, its regex can't
      // match — skip the full scan (the common no-secret case) before touching the engine.
      if (prefilter) {
        if (lowerText === null) lowerText = text.toLowerCase();
        if (!prefilter.some((p) => lowerText.includes(p))) continue;
      }
      let result;
      try {
        // Spread the originating request (method / originalUrl / headers) alongside the response,
        // so a response rule's `when` route/method scope resolves against the REAL request and so
        // request Host/Origin are visible to response rules — rather than the phantom empty request
        // the response phase used to build (which made `when` on a response rule inert).
        result = re.evaluate({ ...(reqCtx || {}), _response: { ...meta, body: text } });
      } catch (err) {
        notify(onError, err, 'onError');
        continue;
      }
      if (!result.blocked) continue;
      // Per-rule enforcement applies to every phase, not just the request. A generated response rule in
      // dry-run must not redact or withhold a body either: "detect until justified" is meaningless if the
      // rule still rewrites what the user sees.
      const responseMode = ruleMode(rule);
      onDetect({ phase: 'response', mode: responseMode, category: rule.category, rule, message: result.message });
      if (responseMode !== 'block') continue; // dry-run: observe only
      if (redactors && redactors.length) {
        // Span redactors on a mutation-decoded rule can't map back to the raw body → fail closed.
        const spanRedactors = redactors.filter((r) => !r.jsonPath);
        if (mutatedSpan && spanRedactors.length) {
          if (!blockRule) blockRule = rule;
        } else {
          redactions.push({ rule, redactors });
        }
      } else if (isHeaderMutation(rule.action)) headerMutations.push(rule);
      else if (!blockRule) blockRule = rule;
    }
    if (mode !== 'block' || (!blockRule && !redactions.length && !headerMutations.length)) return { verdict: 'pass' };
    if (blockRule) return { verdict: 'block' };
    let body = text;
    // Redact the offending spans in the body AND in every (string) header value — so a secret
    // that leaks in a header (Set-Cookie, an echoed X-Api-Key, …) is masked too, and a rule that
    // targets `response.header.*` actually strips the header rather than just detecting it.
    const headers = { ...(meta.headers || {}) };
    for (const { rule, redactors } of redactions) {
      const mask = maskFn(rule.category);
      // action `encode` HTML-escapes the matched value in place (neutralize stored XSS at output);
      // `redact` masks it. jsonPath redactors act on a structural JSON location, span redactors on
      // text spans in the body AND header values. Apply structural first (on clean JSON), then spans.
      const transform = rule.action === 'encode' ? htmlEscape : null;
      const pathRedactors = redactors.filter((r) => r.jsonPath);
      const spanRedactors = redactors.filter((r) => !r.jsonPath);
      if (pathRedactors.length) body = applyPathRedactors(body, pathRedactors, mask, screenCap, transform);
      if (!spanRedactors.length) continue;
      body = applyRedactors(body, spanRedactors, mask, transform);
      if (transform) continue; // encoding is a body/output concern — headers aren't HTML
      for (const name of Object.keys(headers)) {
        const value = headers[name];
        if (typeof value === 'string') {
          headers[name] = applyRedactors(value, spanRedactors, mask);
        } else if (Array.isArray(value)) {
          // Multi-valued headers (Set-Cookie) — redact each entry.
          headers[name] = value.map((item) => (typeof item === 'string' ? applyRedactors(item, spanRedactors, mask) : item));
        }
      }
    }
    for (const rule of headerMutations) applyHeaderMutation(headers, rule);
    return { verdict: 'redact', body, headers };
  };

  // Minimal request context for the response phase: what a response rule's `when` scope and any
  // request-header reference (Host/Origin) need — method, path, and request headers. No body.
  const reqContextFromFetch = (request) => {
    try {
      const u = new URL(request.url);
      const headers = headerObject(request.headers);
      // A fetch Request doesn't expose the Host header (it's set at send time), so derive it from the
      // URL — response rules that compare origins (open-redirect / CORS) need the request Host.
      if (!headers.host) headers.host = u.host;
      return { method: request.method, originalUrl: u.pathname + u.search, headers };
    } catch {
      return undefined;
    }
  };
  const reqContextFromNode = (req) => (req ? { method: req.method, originalUrl: req.url, headers: req.headers || {} } : undefined);

  // Screen a fetch Response (used by .fetch() and — via protection.screenResponse — the Supabase guard).
  const screenResp = async (response, reqCtx) => {
    const read = await readTextResponse(response, screenCap);
    if (read.skip) {
      // Nothing was screened — a leak/PII rule cannot have applied. Record it (a live stream and a
      // binary body are by design; a body-cap or read failure is a coverage hole worth alerting on).
      if (read.skip !== 'not-a-response') recordSkip('response', read.skip, { status: response?.status });
      return response;
    }
    const text = read.text;
    const r = screenText(text, { status: response.status, headers: headerObject(response.headers) }, reqCtx);
    if (r.verdict === 'block') return leakResponse();
    if (r.verdict === 'redact') return rebuildResponse(response, r.body, r.headers);
    return response;
  };

  // Wrap a Node ServerResponse so its (buffered, text) body is screened before it's sent.
  // Opt-in (buffering can delay a streamed response); over 512 KiB it stops buffering and
  // passes through unscanned.
  const wrapNodeResponse = (res, reqCtx) => {
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    const chunks = [];
    let size = 0;
    let overflow = false;
    const MAX = screenCap;
    const collect = (chunk, enc) => {
      if (chunk == null) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8');
      size += buf.length;
      if (size > MAX) {
        // Too big to screen — abandon buffering, but FLUSH what we already captured (the head) plus
        // this chunk before switching to pass-through, so the client gets a complete body (not a
        // truncated one missing everything before the cap was hit).
        for (const c of chunks) origWrite(c);
        chunks.length = 0;
        origWrite(buf);
        overflow = true;
        recordSkip('response', 'body-cap', { bytes: size });
        return;
      }
      chunks.push(buf);
    };
    res.write = function (chunk, enc, cb) {
      if (overflow) return origWrite(chunk, enc, cb);
      collect(chunk, enc);
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    };
    res.end = function (chunk, enc, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; enc = undefined; }
      else if (typeof enc === 'function') { cb = enc; enc = undefined; }
      if (overflow) { if (chunk != null) origWrite(chunk, enc); return origEnd(cb); }
      collect(chunk, enc);
      if (overflow) return origEnd(cb); // collect just flushed head + final chunk on overflow
      const buffer = Buffer.concat(chunks);
      let ct = res.getHeader ? res.getHeader('content-type') : undefined;
      if (Array.isArray(ct)) ct = ct[0];
      const kind = screenableContentType(ct);
      // Skip live streams / binary bodies (incl. an octet-stream that sniffs as binary) — untouched.
      if (kind === 'skip' || (kind === 'sniff' && looksBinary(buffer))) {
        recordSkip('response', kind === 'skip' ? (baseContentType(ct) === 'text/event-stream' ? 'live-stream' : 'non-text-content-type') : 'binary-body');
        for (const c of chunks) origWrite(c);
        return origEnd(cb);
      }
      const text = buffer.toString('utf8');
      let r;
      try {
        r = screenText(text, { status: res.statusCode, headers: res.getHeaders ? res.getHeaders() : {} }, reqCtx);
      } catch (err) {
        notify(onError, err, 'onError');
        for (const c of chunks) origWrite(c);
        return origEnd(cb);
      }
      if (r.verdict === 'block') {
        res.statusCode = 500;
        try { res.setHeader('content-type', 'application/json'); } catch { /* headers sent */ }
        return origEnd(JSON.stringify({ error: 'Response withheld by Patchstack (sensitive data detected)' }), cb);
      }
      if (r.verdict === 'redact') {
        try { res.removeHeader && res.removeHeader('content-length'); } catch { /* ignore */ }
        if (r.headers && res.setHeader) {
          const current = res.getHeaders ? res.getHeaders() : {};
          for (const [name, value] of Object.entries(r.headers)) {
            // content-length was just removed (the redacted body has a new length); never re-set a
            // stale one here or the response truncates/hangs.
            if (name.toLowerCase() === 'content-length') continue;
            if (value === null || value === undefined) {
              try { res.removeHeader && res.removeHeader(name); } catch { /* ignore */ } // header-mutation removal
            } else if (Array.isArray(value)) {
              try { res.setHeader(name, value); } catch { /* ignore invalid header */ } // Set-Cookie array
            } else if (typeof value === 'string' && current[name] !== value) {
              try { res.setHeader(name, value); } catch { /* ignore invalid header */ }
            }
          }
        }
        return origEnd(r.body, cb);
      }
      for (const c of chunks) origWrite(c);
      return origEnd(cb);
    };
  };

  // Egress phase: is this outbound call blocked? (records detection either way)
  const allow = new Set((options.allowHosts ?? []).map((h) => String(h).toLowerCase()));
  const egressShouldBlock = (url, host, method) => {
    if (host && allow.has(host.toLowerCase())) return false;
    let result;
    try {
      result = egressEngine.evaluate({ _egress: { url, host, method } });
    } catch (err) {
      notify(onError, err, 'onError');
      return false;
    }
    if (!result.blocked) return false;
    // Same for egress: a dry-run rule records the outbound attempt without preventing it. Blocking a
    // request the app makes is at least as disruptive as blocking one it receives.
    const egressMode = ruleMode(result.rule);
    onDetect({ phase: 'egress', mode: egressMode, category: result.rule?.category, rule: result.rule, message: result.message });
    return egressMode === 'block';
  };

  const protection = {
    get mode() {
      return mode;
    },
    get rules() {
      return { request: requestRules, response: responseRules, egress: egressRules };
    },

    /**
     * Enforcement coverage: how often the guard FAILED OPEN rather than inspecting, keyed
     * `<phase>:<reason>` (e.g. `response:body-cap`, `request:body-cap`, `response:live-stream`,
     * `egress:resolver-failed`). "Always-on" is not "always inspected" — surface this (or pass
     * `onSkip`) so an unscreened path is visible and alertable rather than silent.
     */
    coverage() {
      return { skipped: { ...skipCounts } };
    },

    // Screen a fetch Response through the response-phase rules (redact/block). Used by
    // .fetch(), and by the Supabase guard on its forwarded upstream response.
    screenResponse: (response, request) => screenResp(response, request ? reqContextFromFetch(request) : undefined),

    // (request) => Response | null   (null = allow, caller proceeds). Request phase only.
    fetchGuard() {
      return async (request) => {
        let result;
        try {
          result = engine.evaluate(await fromFetchRequest(request));
        } catch (err) {
          notify(onError, err, 'onError');
          return null; // fail open
        }
        return decide('request', result, () => blockResponse(result, request), () => null, fetchRequestMeta(request));
      };
    },

    // Wrap a fetch handler: screens the request, then the response (redact/block).
    fetch(handler) {
      const guard = protection.fetchGuard();
      return async (request, ...rest) => {
        const blocked = await guard(request);
        if (blocked) return blocked;
        const response = await handler(request, ...rest);
        return screenResp(response, reqContextFromFetch(request));
      };
    },

    // Express middleware (request phase; expects express-parsed req.query/req.body).
    // Pass { screenResponses: true } to also screen the outgoing response (buffers it).
    express(exprOptions = {}) {
      return (req, res, next) => {
        let result;
        try {
          result = engine.evaluate(req);
        } catch (err) {
          notify(onError, err, 'onError');
          if (exprOptions.screenResponses) wrapNodeResponse(res, reqContextFromNode(req));
          return next();
        }
        decide(
          'request',
          result,
          () => {
            if (isDocumentNavigation((n) => req.headers?.[n])) {
              res.status(403).type('html').send(renderBlockPage({ url: req.originalUrl || req.url || '/', code: result?.rule?.id }));
            } else {
              res.status(403).json(blockBody(result));
            }
          },
          () => {
            if (exprOptions.screenResponses) wrapNodeResponse(res, reqContextFromNode(req));
            next();
          },
          nodeRequestMeta(req),
        );
      };
    },

    // Node / Connect middleware — buffers the body itself (request phase). Register it BEFORE any body
    // parser: it reads the request stream, and exposes what it read as `req.body` so a parser is not
    // also needed. (`.express()` is the other way round — it reads a body somebody else parsed.)
    // Pass { screenResponses: true } to also screen the outgoing response (buffers it).
    node(nodeOptions = {}) {
      const maxBytes = nodeOptions.maxBodyBytes ?? 1024 * 1024;
      return (req, res, next) => {
        // Registered after a body parser, the stream is already at its end: 'data' and 'end' will not fire
        // again, and waiting for them would hold the request open for as long as the client allows. Screen
        // the body the parser left instead — a guard that stops serving the app is a worse outcome than the
        // registration order it was trying to insist on.
        if (req.readableEnded || req.body !== undefined) {
          screenNodeRequest(req, res, next, '', req.body);
          return;
        }

        const chunks = [];
        let size = 0;
        let overflow = false;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            overflow = true;
            return;
          }
          chunks.push(chunk);
        });
        req.on('error', (err) => {
          notify(onError, err, 'onError');
          next();
        });
        req.on('end', () => {
          if (overflow) recordSkip('request', 'body-cap', { bytes: size, limit: maxBytes });
          screenNodeRequest(req, res, next, overflow ? '' : Buffer.concat(chunks).toString('utf8'));
        });
      };

      // `parsedBody`, when given, is a body somebody else already parsed: it replaces the shaped body
      // rather than being re-serialized, because re-encoding it would have to guess a format and a form
      // body handed back as JSON resolves no `post.<field>` at all.
      function screenNodeRequest(req, res, next, rawBody, parsedBody) {
        let shaped;
        let result;
        try {
          shaped = fromNodeRequest(req, rawBody);
          if (parsedBody !== undefined && parsedBody !== null) shaped.body = parsedBody;
          result = engine.evaluate(shaped);
        } catch (err) {
          notify(onError, err, 'onError');
          return next();
        }
        decide(
          'request',
          result,
          () => {
            res.statusCode = 403;
            if (isDocumentNavigation((n) => req.headers?.[n])) {
              res.setHeader('content-type', 'text/html; charset=utf-8');
              res.end(renderBlockPage({ url: req.url || '/', code: result?.rule?.id }));
            } else {
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify(blockBody(result)));
            }
          },
          () => {
            // This guard consumed the request stream to screen it; re-expose the parsed
            // body so a downstream handler (without its own body-parser) can read it.
            if (req.body === undefined) req.body = shaped.body;
            if (nodeOptions.screenResponses) wrapNodeResponse(res, reqContextFromNode(req));
            next();
          },
          nodeRequestMeta(req),
        );
      }
    },
  };

  // Egress interception is opt-in (it wraps the global fetch, and node:http/https on Node).
  if (options.egress) {
    protection.uninstallEgress = await installEgressGuard({
      shouldBlock: egressShouldBlock,
      onBlock: options.onEgressBlock,
      // Route egress coverage gaps (a DNS resolver failure / no resolver on this runtime) into the
      // same skip accounting as the request/response phases.
      onSkip: ({ reason, detail }) => recordSkip('egress', reason, detail),
      dnsScreen: options.screenDns !== false,
      allowHosts: options.allowHosts,
    });
  }

  // Live rule refresh. The guard otherwise reads its rules once, at process start — so a rule that
  // only becomes relevant after boot (a dependency added mid-session and flagged by Pulse, a
  // zero-day published) never applies until the process restarts. A refresh re-fetches and
  // hot-swaps the engines in place; the same tick can be driven by a poll loop (`refreshMs`), a
  // manual `protection.refresh()`, or an authenticated push (`protection.refreshHandler()`).
  const cwd = options.cwd ?? (typeof process !== 'undefined' ? process.cwd() : undefined);
  const live = Boolean(options.siteUuid || options.token);
  const refreshSecret = options.refreshSecret ?? (typeof process !== 'undefined' ? process.env.PATCHSTACK_REFRESH_SECRET : undefined);
  const refreshable = live && (options.refreshMs > 0 || Boolean(refreshSecret));

  // On the Pulse (siteUuid) path, re-post the dependency manifest before re-fetching. A targeted
  // `npm install <pkg>` fires no npm lifecycle hook, so nothing else re-scans; reporting here lets
  // the server flag a newly-added vulnerable dependency and the SAME tick's rule fetch pick up its
  // rule. Loaded once, up front, only when a refresh path is enabled — a refresh-off production
  // guard never pulls in the scan pipeline; a load/report failure never blocks the rule refresh.
  let reporter = null;
  if (refreshable && options.siteUuid && options.reportManifest !== false && cwd) {
    try {
      ({ reportManifest: reporter } = await import('./refresh-manifest.js'));
    } catch (err) {
      notify(onError, err, 'onError'); // scan pipeline unavailable (e.g. an edge runtime) — rules still refresh
    }
  }

  const runRefreshTick = async () => {
    if (reporter) {
      try {
        await reporter(cwd);
      } catch (err) {
        notify(onError, err, 'onError'); // a failed report must not stop the rule refresh
      }
    }
    const next = await resolveRules(options, store, { timeoutMs: options.refreshTimeoutMs, pulseAuth });
    mode = resolveMode(options, next);
    applyBundle(next);
    // After the swap, and only after it: later detections belong to the bundle now running. A refresh
    // that fell back to the cached or bundled ruleset kept the previous rules, and `store.read()` then
    // still holds the previous identity — which is exactly the answer that stays true.
    if (detections) detections.setRulesEtag((await store.read())?.etag ?? null);

    // The tick's own outcome, separate from the guard's. `resolveRules` deliberately absorbs an API or
    // network failure and returns usable rules, which is right for protection and wrong for a poller:
    // a scheduler that only counts THROWN errors reads a fleet-wide outage as a healthy poll and keeps
    // knocking at the normal interval. Reported, not thrown — a caller's manual `refresh()` must not
    // start failing because the platform is down and the cached rules held.
    return next.source ?? { ok: true };
  };

  if (live) {
    // Manual one-shot refresh (also the primitive the loop + push endpoint run).
    protection.refresh = () => runRefreshTick();
    // Authenticated push endpoint — the platform/SaaS hits it for an immediate refresh. No secret
    // configured → the handler 404s (never an open refresh trigger).
    protection.refreshHandler = () => makeRefreshHandler(runRefreshTick, refreshSecret);
  }

  const loop = options.refreshMs > 0 && live
    ? startRefresh(runRefreshTick, { refreshMs: options.refreshMs, onError })
    : null;

  // One method, always present, that reaches everything holding a timer or a buffer: the refresh loop,
  // the block log, the detection reporter. Always present because a lifecycle method that exists only
  // for some configurations is one a caller cannot rely on — and each of these components can be the
  // only one installed, so any of them can be the one left running.
  protection.stop = () => {
    loop?.stop();
    firewallLog?.stop();
    detections?.stop();
  };
  // The name callers already have, kept as an alias for it.
  protection.stopRefresh = protection.stop;
  // Which of the three states reporting is in: requested and running, requested but undeliverable, or
  // not requested. A boolean would collapse the middle one into "off", which is the reassuring reading.
  protection.detectionReporting = detectionReporting;
  // Delivery health, when there is a reporter: what was attempted, acknowledged, refused, and dropped.
  if (detections) protection.detectionHealth = () => detections.health();

  return protection;
}

/**
 * Resolve runtime enforcement mode.
 * Precedence: PATCHSTACK_MODE env > Pulse `enforcement` on the rules bundle > options.mode > dry-run.
 */
function resolveMode(options, bundle) {
  const env = typeof process !== 'undefined' ? process.env?.PATCHSTACK_MODE : undefined;
  if (env === 'block' || env === 'dry-run') return env;
  if (bundle?.enforcement === 'block' || bundle?.enforcement === 'dry-run') return bundle.enforcement;
  if (options?.mode === 'block') return 'block';
  if (options?.mode === 'dry-run') return 'dry-run';
  return 'dry-run';
}

/**
 * WP-format api_key for connector /api/logs/log. Never use the public site UUID.
 * The `.patchstackrc.json` fallback reads the filesystem, so fs/path are imported LAZILY — this
 * module must stay loadable on edge runtimes (Next edge middleware, Workers, Deno, Supabase
 * Functions), where a static `node:fs` import fails to resolve and would take the guard down.
 */
async function resolveApiKey(options) {
  if (typeof options?.apiKey === 'string' && options.apiKey.length > 0) return options.apiKey;
  if (typeof process !== 'undefined') {
    const fromEnv = process.env?.PATCHSTACK_API_KEY;
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  }
  try {
    if (typeof process === 'undefined' || typeof process.cwd !== 'function') return undefined;
    const [{ readFileSync }, { join }] = await Promise.all([import('node:fs'), import('node:path')]);
    const cwd = options?.cwd ?? process.cwd();
    const raw = readFileSync(join(cwd, '.patchstackrc.json'), 'utf8');
    const key = JSON.parse(raw)?.apiKey;
    if (typeof key === 'string' && key.length > 0) return key;
  } catch {
    /* missing, or no filesystem on this runtime — reporting stays off */
  }
  return undefined;
}

/**
 * Credential for the authenticated rules lookup (ADR-0018). Same resolution
 * order and the same edge-runtime caution as resolveApiKey, and falls back to
 * it so guards installed before pulseAuth existed keep authenticating.
 *
 * Returning undefined does not fail the boot — protection still runs on the cached or bundled rules —
 * but the fetch then goes out unauthenticated and the platform refuses it, so the guard stops receiving
 * rules. That is why the caller warns about it at boot rather than treating it as a normal state.
 */
async function resolvePulseAuth(options) {
  if (typeof options?.pulseAuth === 'string' && options.pulseAuth.length > 0) return options.pulseAuth;
  if (typeof process !== 'undefined') {
    const fromEnv = process.env?.PATCHSTACK_PULSE_AUTH;
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  }
  try {
    if (typeof process === 'undefined' || typeof process.cwd !== 'function') return resolveApiKey(options);
    const [{ readFileSync }, { join }] = await Promise.all([import('node:fs'), import('node:path')]);
    const cwd = options?.cwd ?? process.cwd();
    const raw = readFileSync(join(cwd, '.patchstackrc.json'), 'utf8');
    const key = JSON.parse(raw)?.pulseAuth;
    if (typeof key === 'string' && key.length > 0) return key;
  } catch {
    /* missing, or no filesystem here — fall through to the apiKey path */
  }

  return resolveApiKey(options);
}

// --- phase / response helpers -------------------------------------------

function byPhase(rules, phase) {
  return (rules ?? []).filter((r) => (r.phase ?? 'request') === phase);
}

// Classify a content-type for response screening: 'text' = screen; 'sniff' = screen only if the
// bytes aren't binary (octet-stream is often a misdeclared JSON export/config); 'skip' = pass
// through unscreened (live streams, known binary families). SSE is matched on the EXACT base type,
// not a loose substring — `application/json; profile="event-stream"` is not a stream.
function baseContentType(ct) {
  return String(ct || '').toLowerCase().split(';')[0].trim();
}
function screenableContentType(ct) {
  const base = baseContentType(ct);
  if (base === 'text/event-stream') return 'skip'; // live token/SSE stream — never buffer
  if (base === '') return 'text';
  if (/(json|text|xml|html|javascript|csv|yaml|x-www-form-urlencoded)/.test(base)) return 'text';
  if (base === 'application/octet-stream') return 'sniff'; // maybe a text/JSON export mislabeled
  return 'skip'; // image/video/audio/font/pdf/zip/wasm/… — don't buffer binary
}
// Cheap binary sniff over a byte prefix: a NUL byte, or many control chars, means "don't treat as text".
function looksBinary(bytes) {
  const n = Math.min(bytes.length, 512);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return n > 0 && ctrl / n > 0.1;
}

// Returns { text } when the body was fully buffered for screening, or { skip: <reason> } when it was
// NOT screened — the reason is surfaced to `onSkip`/coverage so a fail-open bypass is observable
// instead of silent (an unscreened response is a real hole in enforcement).
async function readTextResponse(response, cap = DEFAULT_SCREEN_CAP) {
  if (!response || typeof response.clone !== 'function') return { skip: 'not-a-response' };
  const ct = response.headers?.get?.('content-type') || '';
  const kind = screenableContentType(ct);
  if (kind === 'skip') return { skip: baseContentType(ct) === 'text/event-stream' ? 'live-stream' : 'non-text-content-type' };
  const sniff = kind === 'sniff';
  const len = Number(response.headers?.get?.('content-length') || 0);
  if (len && len > cap) return { skip: 'body-cap' };
  let clone;
  try {
    clone = response.clone();
  } catch {
    return { skip: 'clone-failed' };
  }

  // Stream the read so a body WITHOUT a Content-Length can't buffer past the cap. Over the cap the
  // response is left UNSCREENED — but we keep draining the clone so the original stays intact.
  const body = clone.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    let over = false;
    let sniffed = !sniff;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (!sniffed) {
          sniffed = true;
          if (looksBinary(value)) return { skip: 'binary-body' };
        }
        size += value.byteLength;
        if (over) continue; // keep draining, stop buffering
        if (size > cap) { over = true; continue; }
        chunks.push(value);
      }
    } catch {
      return { skip: 'read-failed' };
    }
    if (over) return { skip: 'body-cap' };
    try {
      return { text: new TextDecoder().decode(concatBytes(chunks, size)) };
    } catch {
      return { skip: 'decode-failed' };
    }
  }

  try {
    const text = await clone.text();
    if (text.length > cap) return { skip: 'body-cap' };
    if (sniff && looksBinary(new TextEncoder().encode(text.slice(0, 512)))) return { skip: 'binary-body' };
    return { text };
  } catch {
    return { skip: 'read-failed' };
  }
}

function concatBytes(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function headerObject(headers) {
  const out = {};
  headers?.forEach?.((v, k) => { out[k.toLowerCase()] = v; });
  // Set-Cookie is multi-valued; forEach collapses it. Recover the individual cookies so each can
  // be screened (and re-emitted) separately.
  const setCookies = headers?.getSetCookie?.();
  if (setCookies && setCookies.length) out['set-cookie'] = setCookies;
  return out;
}

// True if any of the rule's conditions carries a body-transforming mutation on a SPAN match
// (regex/contains/stripos) — those decode the body before matching, so a span redactor derived from
// the literal/regex can't be located in the raw body. (array_key_value structural redaction decodes
// the JSON itself, so json_decode there is fine and doesn't count.)
function hasSpanMutations(rule) {
  let found = false;
  const walk = (conds) => {
    for (const c of conds ?? []) {
      if (found) return;
      if (Array.isArray(c.rules)) walk(c.rules);
      const isSpan = c.match && (c.match.type === 'regex' || c.match.type === 'contains' || c.match.type === 'stripos');
      if (isSpan && Array.isArray(c.mutations) && c.mutations.length) found = true;
    }
  };
  walk(rule.rule_v2);
  return found;
}

// Derive redaction targets from a rule's own conditions: regex → mask every match;
// contains/stripos → mask the literal. (Other match types can't identify a span → the
// rule falls back to block.)
function extractRedactors(rule) {
  const out = [];
  const walk = (conds) => {
    for (const c of conds ?? []) {
      if (Array.isArray(c.rules)) walk(c.rules);
      const m = c.match;
      if (!m) continue;
      if (m.type === 'regex' && typeof m.value === 'string') {
        // Route through the SAME ReDoS guard detection uses — a catastrophic redactor pattern must
        // not hang the response path (safeRegExp returns null for dangerous/invalid patterns → skip).
        const safe = safeRegExp(m.value);
        if (safe) {
          const flags = safe.flags.includes('g') ? safe.flags : safe.flags + 'g';
          try {
            out.push({ re: new RegExp(safe.source, flags) });
          } catch {
            /* skip invalid */
          }
        }
      } else if ((m.type === 'contains' || m.type === 'stripos') && m.value != null) {
        out.push({ literal: String(m.value) });
      } else if (m.type === 'array_key_value' && m.match && isBodyParam(c.parameter)) {
        // Structural redaction: mask the value at a JSON path (fanning out over arrays) rather than
        // a text span — e.g. key "orders.customers.email" masks that field in every array element.
        const keys = Array.isArray(m.key) ? m.key : [m.key];
        for (const key of keys) {
          out.push({ jsonPath: String(key).split('.'), condition: m.match });
        }
      }
    }
  };
  walk(rule.rule_v2);
  return out;
}

// HTML-entity escape, for the `encode` action (neutralize markup rather than mask it). NOTE: this is
// sound only for HTML text / attribute-VALUE contexts. It does NOT neutralize a `javascript:` / `data:`
// URI or an event-handler name (those carry no HTML metacharacters) — use `block` for a rule that
// targets a URL/scheme context. See the rule-authoring guidance in the triage-vpatch-npm skill.
function htmlEscape(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// `transform` (optional): map a matched span to its replacement (the `encode` action passes
// htmlEscape). Without it, matches are replaced by the `mask` string (the `redact` action).
function applyRedactors(body, redactors, mask, transform) {
  let out = body;
  for (const r of redactors) {
    if (r.re) out = out.replace(r.re, transform ? (m) => transform(m) : mask);
    else if (r.literal) {
      // Detection (matchValue for contains/stripos) is case-insensitive, so mask case-insensitively
      // too — otherwise a `contains: "SECRET"` redactor detects `secret` but masks nothing, serving
      // the leak while reporting a redaction. Escape the literal so it matches literally, not as regex.
      const re = new RegExp(r.literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      out = out.replace(re, (m) => (transform ? transform(m) : mask));
    }
  }
  return out;
}

// A response-body redaction target (array_key_value masks the JSON body). A bare condition with no
// parameter also defaults to the body.
function isBodyParam(parameter) {
  return parameter == null || parameter === 'response.body' || parameter === 'raw' || parameter === 'response.raw';
}

// Build a predicate from the array_key_value nested match, so a path can be masked conditionally
// (only leaves that match) or — with `isset` — unconditionally. Fail-closed (don't mask) on error.
function conditionPredicate(condition) {
  if (!condition || !condition.type) return () => true;
  return (value) => {
    try {
      return matchValue(condition.type, value, condition.value, condition);
    } catch {
      return false;
    }
  };
}

const DEFAULT_SCREEN_CAP = 512 * 1024;

// Effective response-screening size cap for a rule set. Bodies larger than this are passed through
// UNSCREENED (so a redact rule can't mask them — the leak/PII would slip out). A rule can raise the
// ceiling for the whole response phase: `bypass_limit: true` removes the cap entirely (accepts the
// memory cost on a hostile large body), or `max_bytes: <n>` raises it to n. The cap is shared (the
// body is buffered once), so the effective cap is the MAX across all active response rules.
function responseScreenCap(rules) {
  let cap = DEFAULT_SCREEN_CAP;
  for (const r of rules ?? []) {
    if (r && r.bypass_limit === true) return Infinity;
    const n = Number(r && r.max_bytes);
    if (Number.isFinite(n) && n > cap) cap = n;
  }
  return cap;
}

// Apply jsonPath redactors structurally: parse the JSON body, mask each targeted leaf (fanning out
// over arrays at every path segment), re-serialize. Fail-open — a non-JSON / oversized / unparseable
// body is returned unchanged, and any per-leaf error is swallowed.
function applyPathRedactors(text, pathRedactors, mask, cap, transform) {
  if (!pathRedactors.length || typeof text !== 'string' || text.length > cap) return text;
  const head = text.trimStart()[0];
  if (head !== '{' && head !== '[') return text; // not a JSON object/array
  // Preserve out-of-safe-range integers across the parse→stringify round-trip: JSON.parse would
  // round e.g. a 20-digit id. We quote such number tokens to a sentinel string before parsing and
  // unquote them after stringifying, so untouched big ints survive losslessly.
  const preserved = preserveBigInts(text);
  let obj;
  try {
    obj = JSON.parse(preserved);
  } catch {
    return text;
  }
  let changed = false;
  for (const r of pathRedactors) {
    const pred = conditionPredicate(r.condition);
    walkLeaves(obj, r.jsonPath, (loc) => {
      try {
        if (pred(loc.value)) {
          // `encode`: escape the leaf's own value in place; `redact`: replace it with the mask.
          loc.parent[loc.key] = transform ? transform(String(loc.value)) : mask;
          changed = true;
        }
      } catch {
        /* skip this leaf */
      }
    });
  }
  return changed ? restoreBigInts(JSON.stringify(obj)) : text;
}

const BIGINT_OPEN = '__PSBIGINT_9c2f__';
const BIGINT_CLOSE = '__DNEGIB__';

// Quote every out-of-safe-range integer *value* (a bare number token outside a string) into a
// sentinel string, so JSON.parse keeps it verbatim. String-aware scan (respects \ escapes) so a
// number inside a string value is never touched. Plain-ASCII sentinel → survives JSON.stringify.
function preserveBigInts(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; i++; continue; }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = ch === '-' ? i + 1 : i;
      let digits = 0;
      while (j < text.length && text[j] >= '0' && text[j] <= '9') { digits++; j++; }
      const next = text[j];
      const isIntToken = digits > 0 && next !== '.' && next !== 'e' && next !== 'E';
      if (isIntToken && digits >= 16) {
        out += `"${BIGINT_OPEN}${text.slice(i, j)}${BIGINT_CLOSE}"`;
      } else {
        out += text.slice(i, j || i + 1);
      }
      i = j > i ? j : i + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function restoreBigInts(text) {
  if (!text.includes(BIGINT_OPEN)) return text;
  return text.replace(new RegExp(`"${BIGINT_OPEN}(-?\\d+)${BIGINT_CLOSE}"`, 'g'), '$1');
}

// Response-hardening actions. Mutate the (lowercase-keyed) headers object in place; a `null` value
// signals removal to rebuildResponse / the node path. `set-header` sets/overwrites (or `ensure`s only
// when absent); `remove-header` strips; `harden-cookie` adds missing HttpOnly/Secure/SameSite flags.
function isHeaderMutation(action) {
  return action === 'set-header' || action === 'remove-header' || action === 'harden-cookie';
}

function applyHeaderMutation(headers, rule) {
  if (rule.action === 'remove-header') {
    for (const name of rule.remove_headers ?? []) headers[String(name).toLowerCase()] = null;
    return;
  }
  if (rule.action === 'set-header') {
    const ensure = rule.ensure === true; // set only when the header is absent (don't clobber)
    for (const [name, value] of Object.entries(rule.set_headers ?? {})) {
      const key = String(name).toLowerCase();
      const present = headers[key] != null && headers[key] !== '';
      if (ensure && present) continue;
      headers[key] = String(value);
    }
    return;
  }
  if (rule.action === 'harden-cookie') {
    const cookie = headers['set-cookie'];
    const flags = rule.cookie_flags ?? {};
    if (Array.isArray(cookie)) {
      headers['set-cookie'] = cookie.map((c) => (typeof c === 'string' ? hardenCookie(c, flags) : c));
    } else if (typeof cookie === 'string') {
      headers['set-cookie'] = hardenCookie(cookie, flags);
    }
  }
}

function hardenCookie(cookie, { httpOnly = true, secure = true, sameSite = 'Lax' } = {}) {
  let out = String(cookie);
  if (httpOnly && !/;\s*httponly/i.test(out)) out += '; HttpOnly';
  if (secure && !/;\s*secure/i.test(out)) out += '; Secure';
  if (sameSite && !/;\s*samesite\s*=/i.test(out)) out += `; SameSite=${sameSite}`;
  return out;
}

function rebuildResponse(response, body, redactedHeaders) {
  const headers = new Headers(response.headers);
  headers.delete('content-length'); // body length changed after redaction
  if (redactedHeaders) {
    for (const [name, value] of Object.entries(redactedHeaders)) {
      if (value === null || value === undefined) {
        try { headers.delete(name); } catch { /* skip */ } // header-mutation removal
      } else if (typeof value === 'string') {
        if (headers.get(name) !== value) {
          try { headers.set(name, value); } catch { /* invalid header name — skip */ }
        }
      } else if (Array.isArray(value)) {
        // Re-emit each (possibly redacted) Set-Cookie separately (Headers collapses them otherwise).
        try {
          headers.delete(name);
          for (const item of value) headers.append(name, String(item));
        } catch { /* skip */ }
      }
    }
  }
  // Null-body statuses (204/205/304/101) must not carry a body, or the Response constructor throws.
  const nullBody = response.status === 101 || response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(nullBody ? null : body, { status: response.status, statusText: response.statusText, headers });
}

function leakResponse() {
  return new Response(JSON.stringify({ error: 'Response withheld by Patchstack (sensitive data detected)' }), {
    status: 500,
    headers: { 'content-type': 'application/json' }
  });
}

// (rule source / tiered store moved to ./rules/source.js + ./rules/store.js)

// --- responses ----------------------------------------------------------

// Client-facing block text — deliberately generic: no WAF narrative, no rule title. The reason
// detail stays in the server-side log via onDetect.
const BLOCK_MESSAGE = 'This request has been blocked by Patchstack.';

function blockBody(result) {
  // Human text is masked (no WAF narrative, no rule title). The opaque rule id stays for machine
  // consumers (server-fn receipts, support reference); full rule detail lives in the server log.
  return { error: BLOCK_MESSAGE, message: BLOCK_MESSAGE, rule: result?.rule?.id };
}

// A top-level document navigation (vs an XHR/fetch)? Browsers set Sec-Fetch-Dest on navigations;
// fall back to the Accept header. Governs whether a block returns the HTML page or JSON.
function isDocumentNavigation(getHeader) {
  const dest = getHeader('sec-fetch-dest');
  if (dest) return dest === 'document';
  return (getHeader('accept') || '').includes('text/html');
}

// Request-phase block. Serves the branded HTML "Access Denied" page to a browser navigation, and
// masked JSON to XHR/fetch/programmatic clients.
function blockResponse(result, request) {
  if (request && isDocumentNavigation((n) => request.headers.get(n))) {
    return new Response(renderBlockPage({ url: request.url, code: result?.rule?.id }), {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  return new Response(JSON.stringify(blockBody(result)), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

function defaultOnDetect({ phase, mode, category, rule, message }) {
  const tag = mode === 'block' ? 'BLOCK' : 'DETECT (dry-run)';
  console.warn(`[patchstack] ${tag} phase=${phase ?? 'request'} category=${category ?? '?'} rule=${rule?.id ?? '?'} ${message ?? ''}`.trim());
}

/** @param {Request} request */
function fetchRequestMeta(request) {
  if (!request) return {};
  let path = null;
  try {
    path = new URL(request.url).pathname;
  } catch {
    path = typeof request.url === 'string' ? request.url : null;
  }
  return {
    method: request.method ?? null,
    path,
    ip: request.headers?.get?.('x-forwarded-for') ?? null,
    userAgent: request.headers?.get?.('user-agent') ?? null,
  };
}

/** @param {import('http').IncomingMessage & { ip?: string, originalUrl?: string }} req */
function nodeRequestMeta(req) {
  if (!req) return {};
  const headers = req.headers ?? {};
  const ua = headers['user-agent'] ?? headers['User-Agent'];
  const fwd = headers['x-forwarded-for'] ?? headers['X-Forwarded-For'];
  return {
    method: req.method ?? null,
    path: req.originalUrl || req.url || null,
    ip: req.ip ?? (typeof fwd === 'string' ? fwd : null),
    userAgent: typeof ua === 'string' ? ua : Array.isArray(ua) ? ua[0] : null,
  };
}
