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
import { fromFetchRequest } from './engine/fetch.js';
import { fromNodeRequest } from './engine/node.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Supabase-tunnel guard for AI-builder apps (Lovable / TanStack Start + Supabase).
export { createSupabaseGuard, GUARD_PATH } from './supabase-guard.js';

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
  const engine = new RuleEngine({ ...bundle, onError });

  // Given an evaluation result, either enforce (block mode) or just record (dry-run).
  const decide = (result, block, allow) => {
    if (!result || !result.blocked) return allow();
    onDetect({ mode, rule: result.rule, message: result.message });
    return mode === 'block' ? block() : allow();
  };

  const protection = {
    mode,
    rules: bundle,

    // (request) => Response | null   (null = allow, caller proceeds)
    fetchGuard() {
      return async (request) => {
        let result;
        try {
          result = engine.evaluate(await fromFetchRequest(request));
        } catch (err) {
          onError?.(err);
          return null; // fail open
        }
        return decide(result, () => blockResponse(result), () => null);
      };
    },

    // Wrap a fetch handler: export default { fetch: protection.fetch(app.fetch) }
    fetch(handler) {
      const guard = protection.fetchGuard();
      return async (request, ...rest) => (await guard(request)) ?? handler(request, ...rest);
    },

    // Express middleware (expects express-parsed req.query/req.body).
    express() {
      return (req, res, next) => {
        let result;
        try {
          result = engine.evaluate(req);
        } catch (err) {
          onError?.(err);
          return next();
        }
        decide(result, () => res.status(403).json(blockBody(result)), () => next());
      };
    },

    // Node / Connect middleware — buffers the body itself (no body-parser needed).
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
          let result;
          try {
            result = engine.evaluate(fromNodeRequest(req, rawBody));
          } catch (err) {
            onError?.(err);
            return next();
          }
          decide(
            result,
            () => {
              res.statusCode = 403;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify(blockBody(result)));
            },
            () => next(),
          );
        });
      };
    },
  };

  return protection;
}

// --- rule source --------------------------------------------------------

async function resolveRules(options) {
  if (options.rules) {
    return normalizeBundle(options.rules);
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

function blockBody(result) {
  return {
    error: 'Blocked by Patchstack',
    rule: result.rule?.id,
    message: result.message,
  };
}

function blockResponse(result) {
  return new Response(JSON.stringify(blockBody(result)), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

function defaultOnDetect({ mode, rule, message }) {
  const tag = mode === 'block' ? 'BLOCK' : 'DETECT (dry-run)';
  console.warn(`[patchstack] ${tag} rule=${rule?.id ?? '?'} ${message ?? ''}`.trim());
}
