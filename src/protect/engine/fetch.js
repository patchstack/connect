// Web Fetch adapter — runs the node-waf engine on any runtime where a request is a
// WHATWG `Request` and a handler returns a `Response`: Cloudflare Workers, Bun, Deno,
// Hono, Next.js edge, and TanStack Start's `server.ts`. This is the surface AI-builder
// apps actually deploy to, and where require-based instrumentation can't reach.
//
// The engine already consumes a runtime-neutral request shape; this adapter builds that
// shape from a `Request`, so no engine changes are needed beyond keeping the hot path
// free of Node-only APIs.
import { RuleEngine } from './engine.js';

// Build the engine's request shape from a WHATWG Request. The body is read from a
// CLONE so the downstream handler still receives an intact request.
export async function fromFetchRequest(request) {
  const url = new URL(request.url);
  const method = (request.method || 'GET').toUpperCase();

  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const query = {};
  for (const [key, value] of url.searchParams) {
    if (key in query) {
      query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    } else {
      query[key] = value;
    }
  }

  let rawBody = '';
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      rawBody = await request.clone().text();
    } catch {
      rawBody = '';
    }
  }

  const contentType = headers['content-type'] || '';
  let body = {};
  if (rawBody) {
    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = {};
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      body = {};
      for (const [k, v] of new URLSearchParams(rawBody)) {
        body[k] = k in body ? [].concat(body[k], v) : v;
      }
    }
  }

  const uri = url.pathname + url.search;
  const forwarded =
    headers['cf-connecting-ip'] || headers['x-forwarded-for'] || headers['x-real-ip'] || '';

  return {
    method,
    url: uri,
    originalUrl: uri,
    query,
    body,
    headers,
    ip: forwarded.split(',')[0].trim(),
    cookies: parseCookies(headers.cookie),
    // Verbatim body text: preserves literal keys (e.g. `__proto__`) that JSON.stringify
    // drops, so prototype-pollution rules on `raw` are robust.
    _rawBody: rawBody
  };
}

function parseCookies(header) {
  const cookies = {};
  if (!header) {
    return cookies;
  }
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) {
      continue;
    }
    cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return cookies;
}

function defaultBlockResponse(result) {
  return new Response(
    JSON.stringify({
      error: 'Blocked by Patchstack WAF',
      message: result.message,
      timestamp: new Date().toISOString()
    }),
    { status: 403, headers: { 'content-type': 'application/json' } }
  );
}

/**
 * Returns a guard `(request) => Promise<Response|null>`. A `Response` means blocked;
 * `null` means allowed — the caller should proceed to its handler. Accepts either a
 * rules bundle (`{ firewall, whitelists, whitelist_keys }`) or a `RuleEngine` instance.
 * Fails open: a rule that throws never blocks the request.
 */
export function createFetchMiddleware(rulesData, options = {}) {
  const engine =
    rulesData && typeof rulesData.evaluate === 'function'
      ? rulesData
      : new RuleEngine(rulesData);

  const guard = async (request) => {
    const req = await fromFetchRequest(request);

    let result;
    try {
      result = engine.evaluate(req);
    } catch (err) {
      if (options.onError) {
        options.onError(err);
      }
      return null; // fail open
    }

    if (result.blocked) {
      if (options.onBlock) {
        options.onBlock({
          rule: result.rule,
          message: result.message,
          request: { method: req.method, url: req.url, ip: req.ip }
        });
      }
      return (options.response || defaultBlockResponse)(result);
    }

    return null;
  };

  guard.engine = engine;
  return guard;
}

/**
 * Wrap a fetch handler so every request is screened first. One-line hook:
 *   export default { fetch: wrapFetchHandler(app.fetch, rulesData) }
 */
export function wrapFetchHandler(handler, rulesData, options = {}) {
  const guard = createFetchMiddleware(rulesData, options);
  const wrapped = async (request, ...rest) => {
    const blocked = await guard(request);
    return blocked ?? handler(request, ...rest);
  };
  wrapped.engine = guard.engine;
  return wrapped;
}
