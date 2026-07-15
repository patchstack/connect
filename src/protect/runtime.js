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
    redactors: rule.action === 'redact' ? extractRedactors(rule) : null
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
    for (const { rule, redactors } of redactions) body = applyRedactors(body, redactors, maskFn(rule.category));
    return { verdict: 'redact', body };
  };

  // Screen a fetch Response (used by .fetch() and — via protection.screenResponse — the Supabase guard).
  const screenResp = async (response) => {
    const text = await readTextResponse(response);
    if (text == null) return response;
    const r = screenText(text, { status: response.status, headers: headerObject(response.headers) });
    if (r.verdict === 'block') return leakResponse();
    if (r.verdict === 'redact') return rebuildResponse(response, r.body);
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
    const MAX = 512 * 1024;
    const collect = (chunk, enc) => {
      if (chunk == null) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8');
      size += buf.length;
      if (size > MAX) { overflow = true; return; }
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
      const text = Buffer.concat(chunks).toString('utf8');
      let ct = res.getHeader ? res.getHeader('content-type') : undefined;
      if (Array.isArray(ct)) ct = ct[0];
      if (!isTextCT(ct)) { for (const c of chunks) origWrite(c); return origEnd(cb); }
      let r;
      try {
        r = screenText(text, { status: res.statusCode, headers: {} });
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

  // Egress interception is opt-in (it wraps the global fetch).
  if (options.egress) {
    protection.uninstallEgress = installEgressGuard({ shouldBlock: egressShouldBlock, onBlock: options.onEgressBlock });
  }

  return protection;
}

// --- phase / response helpers -------------------------------------------

function byPhase(rules, phase) {
  return (rules ?? []).filter((r) => (r.phase ?? 'request') === phase);
}

async function readTextResponse(response) {
  if (!response || typeof response.clone !== 'function') return null;
  const ct = (response.headers?.get?.('content-type') || '').toLowerCase();
  const isText = ct === '' || /(json|text|xml|html|javascript|csv|yaml|x-www-form-urlencoded)/.test(ct);
  if (!isText) return null;
  const len = Number(response.headers?.get?.('content-length') || 0);
  if (len && len > 512 * 1024) return null;
  try {
    const text = await response.clone().text();
    return text.length > 512 * 1024 ? null : text;
  } catch {
    return null;
  }
}

function headerObject(headers) {
  const out = {};
  headers?.forEach?.((v, k) => { out[k.toLowerCase()] = v; });
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
        const parsed = m.value.match(/^\/(.+)\/([a-z]*)$/is);
        if (parsed) {
          const flags = parsed[2].includes('g') ? parsed[2] : parsed[2] + 'g';
          try {
            out.push({ re: new RegExp(parsed[1], flags) });
          } catch {
            /* skip invalid */
          }
        }
      } else if ((m.type === 'contains' || m.type === 'stripos') && m.value != null) {
        out.push({ literal: String(m.value) });
      }
    }
  };
  walk(rule.rule_v2);
  return out;
}

function applyRedactors(body, redactors, mask) {
  let out = body;
  for (const r of redactors) {
    if (r.re) out = out.replace(r.re, mask);
    else if (r.literal) out = out.split(r.literal).join(mask);
  }
  return out;
}

function rebuildResponse(response, body) {
  const headers = new Headers(response.headers);
  headers.delete('content-length'); // body length changed after redaction
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
  if (options.siteUuid) {
    const client = new PulseRuleClient({ siteUuid: options.siteUuid, baseUrl: options.pulseRulesUrl });
    const res = await client.getRules();
    if (res.success) {
      const bundle = normalizeBundle(res);
      cacheWrite(options.cacheDir, bundle);
      return bundle;
    }
    const cached = cacheRead(options.cacheDir);
    if (cached) {
      options.onError?.(new Error(`pulse rule fetch failed (${res.error}); using cached bundle`));
      return normalizeBundle(cached);
    }
    if (options.rules) {
      options.onError?.(new Error(`pulse rule fetch failed (${res.error}); using bundled fallback`));
      return normalizeBundle(options.rules);
    }
    options.onError?.(new Error(`pulse rule fetch failed (${res.error}); no cache — running with no rules`));
    return emptyBundle();
  }

  if (options.token) {
    const client = new PatchstackRuleClient({ token: options.token, baseUrl: options.baseUrl });
    const res = await client.getRules();
    if (res.success) {
      const bundle = normalizeBundle(res);
      cacheWrite(options.cacheDir, bundle);
      return bundle;
    }
    const cached = cacheRead(options.cacheDir);
    if (cached) {
      options.onError?.(new Error(`rule fetch failed (${res.error}); using cached bundle`));
      return normalizeBundle(cached);
    }
    options.onError?.(new Error(`rule fetch failed (${res.error}); no cache — running with no rules`));
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

function cachePath(dir) {
  return join(dir, 'patchstack-rules.json');
}

function cacheWrite(dir, bundle) {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(dir), JSON.stringify(bundle));
  } catch {
    /* cache is best-effort */
  }
}

function cacheRead(dir) {
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(cachePath(dir), 'utf8'));
  } catch {
    return null;
  }
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
