// Raw Node.js / Connect adapter — for traditional Node servers where the request is a
// `http.IncomingMessage` and the body is NOT already parsed (plain `http`, Connect,
// Express without a body-parser, Fastify via its Node req). It buffers the body once,
// builds the engine's request shape, and blocks or calls `next()`.
//
// This complements the Express `createMiddleware` (which assumes `req.body`/`req.query`
// are already populated) and the Web-Fetch adapter (Workers/edge). Mount it FIRST, before
// any body-parser — it consumes the stream and exposes the parsed body as `req.body`.
import { resolveClientIp } from '../client-ip.js';
import { RuleEngine } from './engine.js';
import { parseBody } from './fetch.js';
import { notify } from '../notify.js';

// Build the engine's request shape from a Node IncomingMessage + its raw body text.
export function fromNodeRequest(req, rawBody = '', options = {}) {
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
  let files;
  if (rawBody) {
    // Same permissive content-type handling as the fetch adapter (+json / text/plain / no-CT bodies
    // still populate post.<field>; multipart exposes field + file metadata) on a raw-Node server too.
    const parsed = parseBody(rawBody, contentType);
    body = parsed.body;
    files = parsed.files;
  }

  const uri = url.pathname + url.search;
  // Resolved once, from the socket peer the transport observed. `req.ip` is deliberately not consulted:
  // under Express's `trust proxy` it is itself header-derived by a policy this guard has not verified.
  const client = resolveClientIp({
    peer: req.socket?.remoteAddress,
    headers,
    trustedProxy: options.trustedProxy,
  });

  return {
    method,
    url: uri,
    originalUrl: uri,
    query,
    body,
    files,
    headers,
    ip: client.ip ?? '',
    _clientIp: client,
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
        // The caller's policy reaches the shaping, or this adapter would always report the socket peer
        // even where its caller declared a trusted front end.
        shaped = fromNodeRequest(req, rawBody, { trustedProxy: options.trustedProxy }); // never crash
        result = engine.evaluate(shaped);
      } catch (err) {
        notify(options.onError, err, 'onError');
        return next(); // fail open
      }

      if (result.blocked) {
        // Contained, as on the fetch path: a throw here would replace the block response with the
        // callback's exception.
        notify(options.onBlock, {
          rule: result.rule,
          message: result.message,
          request: { method: shaped.method, url: shaped.url, ip: shaped.ip }
        }, 'onBlock');
        return (options.response || defaultBlock)(res, result);
      }

      // Expose the parsed body downstream so a body-parser isn't also required.
      req.body = shaped.body;
      next();
    });
  };
}
