// Web Fetch adapter — runs the node-waf engine on any runtime where a request is a
// WHATWG `Request` and a handler returns a `Response`: Cloudflare Workers, Bun, Deno,
// Hono, Next.js edge, and TanStack Start's `server.ts`. This is the surface AI-builder
// apps actually deploy to, and where require-based instrumentation can't reach.
//
// The engine already consumes a runtime-neutral request shape; this adapter builds that
// shape from a `Request`, so no engine changes are needed beyond keeping the hot path
// free of Node-only APIs.
import { RuleEngine } from './engine.js';

// Cap how much request body we buffer for inspection. A larger body is left UNSCANNED
// (fail-open) rather than buffered into memory — matches the node adapter's maxBodyBytes.
const MAX_BODY_BYTES = 1024 * 1024;

// Build the engine's request shape from a WHATWG Request. The body is read from a
// CLONE so the downstream handler still receives an intact request.
export async function fromFetchRequest(request, options = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
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
    rawBody = await readCappedText(request, maxBodyBytes);
  }

  const contentType = headers['content-type'] || '';
  let body = {};
  let files;
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
    } else if (contentType.includes('multipart/form-data')) {
      const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
      if (boundary) {
        const parsed = parseMultipart(rawBody, boundary);
        body = parsed.body;
        files = parsed.files;
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
    files,
    headers,
    ip: forwarded.split(',')[0].trim(),
    cookies: parseCookies(headers.cookie),
    // Verbatim body text: preserves literal keys (e.g. `__proto__`) that JSON.stringify
    // drops, so prototype-pollution rules on `raw` are robust.
    _rawBody: rawBody
  };
}

// Read a request body as text, but leave it UNSCANNED (fail-open) past `max` bytes so a huge
// upload can't be buffered for inspection. A declared oversize (Content-Length) is skipped before
// reading; anything else is read from a clone (so the downstream handler keeps an intact body) and
// discarded if it turns out over the cap.
async function readCappedText(request, max) {
  const declared = Number(request.headers?.get?.('content-length') || 0);
  if (declared && declared > max) return '';
  let clone;
  try {
    clone = request.clone();
  } catch {
    return '';
  }
  try {
    const text = await clone.text();
    return text.length > max ? '' : text;
  } catch {
    return '';
  }
}

// Minimal multipart/form-data parser: enough to expose field names + values (so `post.<field>`
// and `raw` rules match uploads, e.g. a `__proto__` field name) and file metadata (filename via
// `files.<field>`). We only need the textual structure, not the binary file contents.
function parseMultipart(rawBody, boundary) {
  const body = {};
  const files = {};
  for (const part of rawBody.split('--' + boundary)) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const rawHeaders = part.slice(0, headerEnd);
    const disposition = /content-disposition:[^\r\n]*/i.exec(rawHeaders)?.[0];
    if (!disposition) continue;
    const name = /name="([^"]*)"/i.exec(disposition)?.[1];
    if (name == null) continue;
    const content = part.slice(headerEnd + 4).replace(/\r\n$/, '');
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    if (filename !== undefined) {
      files[name] = filename; // engine resolves files.<name> → the uploaded filename
    } else {
      body[name] = name in body ? [].concat(body[name], content) : content;
    }
  }
  return { body, files };
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
