// Raw Node.js / Connect adapter — for traditional Node servers where the request is a
// `http.IncomingMessage` and the body is NOT already parsed (plain `http`, Connect,
// Express without a body-parser, Fastify via its Node req). It buffers the body once,
// builds the engine's request shape, and blocks or calls `next()`.
//
// This complements the Express `createMiddleware` (which assumes `req.body`/`req.query`
// are already populated) and the Web-Fetch adapter (Workers/edge). Mount it FIRST, before
// any body-parser — it consumes the stream and exposes the parsed body as `req.body`.
import { RuleEngine } from './engine.js';

// Build the engine's request shape from a Node IncomingMessage + its raw body text.
export function fromNodeRequest(req, rawBody = '') {
  const method = (req.method || 'GET').toUpperCase();

  const headers = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }

  // An unusual Host header or req.url can make `new URL` throw; shaping must never crash the
  // request (fail-open), so fall back to a safe base.
  const host = headers.host || 'localhost';
  let url;
  try {
    url = new URL(req.url || '/', `http://${host}`);
  } catch {
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      url = new URL('http://localhost/');
    }
  }

  const query = {};
  for (const [key, value] of url.searchParams) {
    if (key in query) {
      query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    } else {
      query[key] = value;
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
    ip: forwarded.split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '',
    cookies: parseCookies(headers.cookie),
    // Verbatim body text: preserves literal keys (e.g. `__proto__`) that JSON.stringify drops.
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

function defaultBlock(res, result) {
  res.statusCode = 403;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      error: 'Blocked by Patchstack WAF',
      message: result.message,
      timestamp: new Date().toISOString()
    })
  );
}

/**
 * Connect/Express-style middleware `(req, res, next)` that buffers the body itself.
 * Accepts a `RuleEngine` instance or a `{ firewall, whitelists, whitelist_keys }` bundle.
 * Fails open: an engine error (or oversized body) never blocks the request.
 * Options: `{ maxBodyBytes = 1MiB, onBlock, onError, response }`.
 */
export function createNodeMiddleware(rulesData, options = {}) {
  const engine =
    rulesData && typeof rulesData.evaluate === 'function' ? rulesData : new RuleEngine(rulesData);
  const maxBytes = options.maxBodyBytes ?? 1024 * 1024;

  return function guard(req, res, next) {
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

    req.on('error', (err) => next(err));

    req.on('end', () => {
      let result;
      let shaped;
      try {
        const rawBody = overflow ? '' : Buffer.concat(chunks).toString('utf8');
        shaped = fromNodeRequest(req, rawBody); // shaping is inside the try too — never crash
        result = engine.evaluate(shaped);
      } catch (err) {
        if (options.onError) {
          options.onError(err);
        }
        return next(); // fail open
      }

      if (result.blocked) {
        if (options.onBlock) {
          options.onBlock({
            rule: result.rule,
            message: result.message,
            request: { method: shaped.method, url: shaped.url, ip: shaped.ip }
          });
        }
        return (options.response || defaultBlock)(res, result);
      }

      // Expose the parsed body downstream so a body-parser isn't also required.
      req.body = shaped.body;
      next();
    });
  };
}
