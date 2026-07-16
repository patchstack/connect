// @patchstack/protect — "Protect = respond".
//
// One entry point that composes the node-waf engine + adapters with:
//   - a rule source: an explicit bundle, or fetched from the Patchstack API (token),
//     with a disk cache so the engine keeps working on last-known-good if the API is down
//   - execution modes: 'dry-run' (detect + log, never block — the safe onramp) and
//     'block' (enforce). Default is 'dry-run'.
//   - fail-open everywhere: a rule/engine error never blocks (or crashes) a request.
//
// Runtime guards: .express(), .node(), .fetch(handler) / .fetchGuard() — same policy,
// every runtime an AI builder deploys to.
// Vendored node-waf engine (this package is self-contained — no @patchstack/node-waf dep).
import { RuleEngine, PatchstackRuleClient } from './engine/index.js';
import { matchValue, walkLeaves, safeRegExp } from './engine/engine.js';
import { PulseRuleClient } from './engine/pulse-client.js';
import { fromFetchRequest } from './engine/fetch.js';
import { fromNodeRequest } from './engine/node.js';
import { installEgressGuard } from './egress.js';
import { DEFAULT_RESPONSE_RULES, DEFAULT_EGRESS_RULES } from './defaults.js';
import { renderBlockPage } from './block-page.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
  const mode = options.mode === 'block' ? 'block' : 'dry-run';
  const onError = options.onError;
  const onDetect = options.onDetect ?? defaultOnDetect;

  const bundle = await resolveRules(options);
  const incoming = bundle.firewall ?? [];

  // Split the delivered ruleset by phase (default "request"), merging phase defaults +
  // per-call overrides. Detection is fully rule-driven — nothing hardcoded.
  const requestRules = byPhase(incoming, 'request');
  const responseRules = [...(options.responseRules ?? DEFAULT_RESPONSE_RULES), ...byPhase(incoming, 'response')];
  const screenCap = responseScreenCap(responseRules); // max body we'll buffer/screen (rules can raise it)
  const egressRules = [...(options.egressRules ?? DEFAULT_EGRESS_RULES), ...byPhase(incoming, 'egress')];

  const engine = new RuleEngine({
    firewall: requestRules,
    whitelists: bundle.whitelists,
    whitelist_keys: bundle.whitelist_keys,
    onError
  });
  // One engine per response rule so we can find ALL matches (to redact each). `action:
  // "redact"` masks the offending span(s); anything else withholds the whole response.
  const responseRuleSet = responseRules.map((rule) => ({
    rule,
    engine: new RuleEngine({ firewall: [rule], onError }),
    redactors: rule.action === 'redact' || rule.action === 'encode' ? extractRedactors(rule) : null
  }));
  const egressEngine = new RuleEngine({ firewall: egressRules, onError });
  const maskFn =
    typeof options.maskWith === 'function'
      ? options.maskWith
      : () => (typeof options.maskWith === 'string' ? options.maskWith : '[REDACTED]');

  // Given a request/egress result, enforce (block mode) or just record (dry-run).
  const decide = (phase, result, block, allow) => {
    if (!result || !result.blocked) return allow();
    onDetect({ phase, mode, category: result.rule?.category, rule: result.rule, message: result.message });
    return mode === 'block' ? block() : allow();
  };

  // Response phase core: screen a text body → { verdict: 'pass'|'block'|'redact', body? }.
  // redact masks matched spans; block withholds; block wins over redact. Enforcement only in
  // block mode (dry-run records via onDetect but returns 'pass').
  const isTextCT = (ct) => {
    ct = (ct || '').toLowerCase();
    return ct === '' || /(json|text|xml|html|javascript|csv|yaml|x-www-form-urlencoded)/.test(ct);
  };
  const screenText = (text, meta) => {
    let blockRule = null;
    const redactions = [];
    for (const { rule, engine: re, redactors } of responseRuleSet) {
      let result;
      try {
        result = re.evaluate({ _response: { ...meta, body: text } });
      } catch (err) {
        onError?.(err);
        continue;
      }
      if (!result.blocked) continue;
      onDetect({ phase: 'response', mode, category: rule.category, rule, message: result.message });
      if (mode !== 'block') continue; // dry-run: observe only
      if (redactors && redactors.length) redactions.push({ rule, redactors });
      else if (!blockRule) blockRule = rule;
    }
    if (mode !== 'block' || (!blockRule && !redactions.length)) return { verdict: 'pass' };
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
    return { verdict: 'redact', body, headers };
  };

  // Screen a fetch Response (used by .fetch() and — via protection.screenResponse — the Supabase guard).
  const screenResp = async (response) => {
    const text = await readTextResponse(response, screenCap);
    if (text == null) return response;
    const r = screenText(text, { status: response.status, headers: headerObject(response.headers) });
    if (r.verdict === 'block') return leakResponse();
    if (r.verdict === 'redact') return rebuildResponse(response, r.body, r.headers);
    return response;
  };

  // Wrap a Node ServerResponse so its (buffered, text) body is screened before it's sent.
  // Opt-in (buffering can delay a streamed response); over 512 KiB it stops buffering and
  // passes through unscanned.
  const wrapNodeResponse = (res) => {
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
      const text = Buffer.concat(chunks).toString('utf8');
      let ct = res.getHeader ? res.getHeader('content-type') : undefined;
      if (Array.isArray(ct)) ct = ct[0];
      if (!isTextCT(ct)) { for (const c of chunks) origWrite(c); return origEnd(cb); }
      let r;
      try {
        r = screenText(text, { status: res.statusCode, headers: res.getHeaders ? res.getHeaders() : {} });
      } catch (err) {
        onError?.(err);
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
            if (Array.isArray(value)) {
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
      onError?.(err);
      return false;
    }
    if (!result.blocked) return false;
    onDetect({ phase: 'egress', mode, category: result.rule?.category, rule: result.rule, message: result.message });
    return mode === 'block';
  };

  const protection = {
    mode,
    rules: { request: requestRules, response: responseRules, egress: egressRules },

    // Screen a fetch Response through the response-phase rules (redact/block). Used by
    // .fetch(), and by the Supabase guard on its forwarded upstream response.
    screenResponse: (response) => screenResp(response),

    // (request) => Response | null   (null = allow, caller proceeds). Request phase only.
    fetchGuard() {
      return async (request) => {
        let result;
        try {
          result = engine.evaluate(await fromFetchRequest(request));
        } catch (err) {
          onError?.(err);
          return null; // fail open
        }
        return decide('request', result, () => blockResponse(result, request), () => null);
      };
    },

    // Wrap a fetch handler: screens the request, then the response (redact/block).
    fetch(handler) {
      const guard = protection.fetchGuard();
      return async (request, ...rest) => {
        const blocked = await guard(request);
        if (blocked) return blocked;
        const response = await handler(request, ...rest);
        return screenResp(response);
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
          onError?.(err);
          if (exprOptions.screenResponses) wrapNodeResponse(res);
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
            if (exprOptions.screenResponses) wrapNodeResponse(res);
            next();
          },
        );
      };
    },

    // Node / Connect middleware — buffers the body itself (request phase).
    // Pass { screenResponses: true } to also screen the outgoing response (buffers it).
    node(nodeOptions = {}) {
      const maxBytes = nodeOptions.maxBodyBytes ?? 1024 * 1024;
      return (req, res, next) => {
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
          onError?.(err);
          next();
        });
        req.on('end', () => {
          const rawBody = overflow ? '' : Buffer.concat(chunks).toString('utf8');
          let shaped;
          let result;
          try {
            shaped = fromNodeRequest(req, rawBody);
            result = engine.evaluate(shaped);
          } catch (err) {
            onError?.(err);
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
              if (nodeOptions.screenResponses) wrapNodeResponse(res);
              next();
            },
          );
        });
      };
    },
  };

  // Egress interception is opt-in (it wraps the global fetch, and node:http/https on Node).
  if (options.egress) {
    protection.uninstallEgress = await installEgressGuard({
      shouldBlock: egressShouldBlock,
      onBlock: options.onEgressBlock,
      dnsScreen: options.screenDns !== false,
      allowHosts: options.allowHosts,
    });
  }

  return protection;
}

// --- phase / response helpers -------------------------------------------

function byPhase(rules, phase) {
  return (rules ?? []).filter((r) => (r.phase ?? 'request') === phase);
}

async function readTextResponse(response, cap = DEFAULT_SCREEN_CAP) {
  if (!response || typeof response.clone !== 'function') return null;
  const ct = (response.headers?.get?.('content-type') || '').toLowerCase();
  const isText = ct === '' || /(json|text|xml|html|javascript|csv|yaml|x-www-form-urlencoded)/.test(ct);
  if (!isText) return null;
  const len = Number(response.headers?.get?.('content-length') || 0);
  if (len && len > cap) return null;
  try {
    const text = await response.clone().text();
    return text.length > cap ? null : text;
  } catch {
    return null;
  }
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

// HTML-entity escape, for the `encode` action (neutralize markup rather than mask it).
function htmlEscape(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// `transform` (optional): map a matched span to its replacement (the `encode` action passes
// htmlEscape). Without it, matches are replaced by the `mask` string (the `redact` action).
function applyRedactors(body, redactors, mask, transform) {
  let out = body;
  for (const r of redactors) {
    if (r.re) out = out.replace(r.re, transform ? (m) => transform(m) : mask);
    else if (r.literal) out = out.split(r.literal).join(transform ? transform(r.literal) : mask);
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
  let obj;
  try {
    obj = JSON.parse(text);
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
  return changed ? JSON.stringify(obj) : text;
}

function rebuildResponse(response, body, redactedHeaders) {
  const headers = new Headers(response.headers);
  headers.delete('content-length'); // body length changed after redaction
  if (redactedHeaders) {
    for (const [name, value] of Object.entries(redactedHeaders)) {
      if (typeof value === 'string') {
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
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function leakResponse() {
  return new Response(JSON.stringify({ error: 'Response withheld by Patchstack (sensitive data detected)' }), {
    status: 500,
    headers: { 'content-type': 'application/json' }
  });
}

// --- rule source --------------------------------------------------------

async function resolveRules(options) {
  const cache = makeCache(options);

  if (options.siteUuid) {
    const prior = await cache.read(); // { bundle, etag } | null
    const client = new PulseRuleClient({ siteUuid: options.siteUuid, baseUrl: options.pulseRulesUrl, etag: prior?.etag });
    const res = await client.getRules();
    if (res.success && res.notModified && prior?.bundle) return normalizeBundle(prior.bundle);
    if (res.success && !res.notModified) {
      const bundle = normalizeBundle(res);
      await cache.write({ bundle, etag: res.etag ?? null });
      return bundle;
    }
    if (prior?.bundle) {
      options.onError?.(new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); using cached bundle`));
      return normalizeBundle(prior.bundle);
    }
    if (options.rules) {
      options.onError?.(new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); using bundled fallback`));
      return normalizeBundle(options.rules);
    }
    options.onError?.(new Error(`pulse rule fetch failed (${res.error ?? 'no usable response'}); no cache — running with no rules`));
    return emptyBundle();
  }

  if (options.token) {
    const prior = await cache.read();
    const client = new PatchstackRuleClient({ token: options.token, baseUrl: options.baseUrl, etag: prior?.etag });
    const res = await client.getRules();
    if (res.success && res.notModified && prior?.bundle) return normalizeBundle(prior.bundle);
    if (res.success && !res.notModified) {
      const bundle = normalizeBundle(res);
      await cache.write({ bundle, etag: res.etag ?? null });
      return bundle;
    }
    if (prior?.bundle) {
      options.onError?.(new Error(`rule fetch failed (${res.error ?? 'no usable response'}); using cached bundle`));
      return normalizeBundle(prior.bundle);
    }
    options.onError?.(new Error(`rule fetch failed (${res.error ?? 'no usable response'}); no cache — running with no rules`));
    return emptyBundle();
  }

  if (options.rules) {
    return normalizeBundle(options.rules);
  }

  return emptyBundle();
}

function normalizeBundle(b) {
  return {
    firewall: Array.isArray(b.firewall) ? b.firewall : [],
    whitelists: Array.isArray(b.whitelists) ? b.whitelists : [],
    whitelist_keys: b.whitelist_keys ?? {},
  };
}

function emptyBundle() {
  return { firewall: [], whitelists: [], whitelist_keys: {} };
}

// The cache stores an envelope { bundle, etag } so a restart can revalidate with If-None-Match. A
// pluggable adapter (options.ruleCache) lets runtimes without a filesystem (Workers/Deno) persist
// last-known-good in their own store; the default is a disk cache under options.cacheDir. Both
// paths are best-effort — a read/write error yields no cache rather than throwing.
function makeCache(options) {
  const adapter = options.ruleCache;
  if (adapter && typeof adapter.read === 'function' && typeof adapter.write === 'function') {
    return {
      read: async () => {
        try {
          return toEnvelope(await adapter.read());
        } catch {
          return null;
        }
      },
      write: async (env) => {
        try {
          await adapter.write(env);
        } catch {
          /* best-effort */
        }
      },
    };
  }
  const dir = options.cacheDir;
  return {
    read: async () => cacheRead(dir),
    write: async (env) => cacheWrite(dir, env),
  };
}

function cachePath(dir) {
  return join(dir, 'patchstack-rules.json');
}

function cacheWrite(dir, env) {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(dir), JSON.stringify(env));
  } catch {
    /* cache is best-effort */
  }
}

function cacheRead(dir) {
  if (!dir) return null;
  try {
    return toEnvelope(JSON.parse(readFileSync(cachePath(dir), 'utf8')));
  } catch {
    return null;
  }
}

// Accept the current { bundle, etag } envelope and a legacy bare bundle (pre-envelope cache files).
function toEnvelope(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.bundle && typeof value.bundle === 'object') {
    return { bundle: value.bundle, etag: value.etag ?? null };
  }
  if (Array.isArray(value.firewall) || Array.isArray(value.whitelists)) {
    return { bundle: value, etag: null }; // legacy bare-bundle cache file
  }
  return null;
}

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
