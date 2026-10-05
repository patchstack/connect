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
import { parseCookieHeader } from './cookies.js';
import { appendOwn, setOwn } from './own.js';
import { REQUEST_TARGET, requestField } from './normalizer.js';

/**
 * Read a Node request body, keeping at most `maxBytes` of it.
 *
 * The whole stream is consumed; bytes past the cap are counted and dropped rather than retained. `done`
 * receives `(error)` or `(null, { text, overflow, size })`, where `text` is the retained prefix — the
 * part that is screened, as on the Fetch path — and `overflow` says the body was longer than it.
 *
 * The cap and `size` are in bytes. A stream something upstream switched to text (`setEncoding`) delivers
 * strings, which are measured and retained as the bytes they encode. A prefix that ends partway through a
 * UTF-8 character ends before that character instead. `done` is called once.
 *
 * `error` is the stream's own error. A chunk this reader cannot use is not one: the body is then read to
 * its end unscreened, and reported as `{ text: '', failed: true }` so the caller can fail open.
 */
export function readBodyPrefix(req, maxBytes, done) {
  const chunks = [];
  let retained = 0;
  let size = 0;
  let failed = false;
  let finished = false;
  const finish = (error, read) => {
    if (finished) return;
    finished = true;
    done(error, read);
  };
  req.on('data', (chunk) => {
    if (failed) return;
    try {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, req.readableEncoding || 'utf8') : chunk;
      size += bytes.length;
      const take = Math.min(bytes.length, maxBytes - retained);
      if (take <= 0) return;
      chunks.push(take === bytes.length ? bytes : bytes.subarray(0, take));
      retained += take;
    } catch {
      failed = true;
      chunks.length = 0;
    }
  });
  req.on('error', (error) => finish(error));
  req.on('end', () => {
    if (failed) {
      finish(null, { text: '', overflow: false, size, failed: true });
      return;
    }
    const prefix = Buffer.concat(chunks);
    const overflow = size > maxBytes;
    const text = (overflow ? prefix.subarray(0, completeUtf8Length(prefix)) : prefix).toString('utf8');
    finish(null, { text, overflow, size, failed: false });
  });
}

// The length of `bytes` without a UTF-8 sequence left incomplete at its end.
function completeUtf8Length(bytes) {
  let start = bytes.length - 1;
  // Back over at most three continuation bytes (10xxxxxx) to the byte that begins the last sequence.
  while (start >= 0 && bytes.length - start <= 3 && (bytes[start] & 0xc0) === 0x80) start--;
  if (start < 0) return bytes.length;
  const lead = bytes[start];
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return bytes.length - start < needed ? start : bytes.length;
}

// Build the engine's request shape from a Node IncomingMessage + its raw body text.
export function fromNodeRequest(req, rawBody = '', options = {}) {
  const method = (req.method || 'GET').toUpperCase();

  const headers = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    setOwn(headers, key.toLowerCase(), Array.isArray(value) ? value.join(', ') : value);
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
    appendOwn(query, key, value);
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
    [REQUEST_TARGET]: requestField(req, 'originalUrl') ?? requestField(req, 'url'),
    method,
    url: uri,
    originalUrl: uri,
    query,
    body,
    files,
    headers,
    ip: client.ip ?? '',
    _clientIp: client,
    cookies: parseCookieHeader(headers.cookie),
    // Verbatim body text: preserves literal keys (e.g. `__proto__`) that JSON.stringify drops.
    _rawBody: rawBody
  };
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
 * Fails open: an engine error never blocks the request. A body longer than `maxBodyBytes` has its first
 * `maxBodyBytes` screened, is reported to `onSkip` as `body-cap`, and is not exposed as `req.body`.
 * Options: `{ maxBodyBytes = 1MiB, onBlock, onError, onSkip, response }`.
 */
export function createNodeMiddleware(rulesData, options = {}) {
  const engine =
    rulesData && typeof rulesData.evaluate === 'function' ? rulesData : new RuleEngine(rulesData);
  const maxBytes = options.maxBodyBytes ?? 1024 * 1024;

  return function guard(req, res, next) {
    readBodyPrefix(req, maxBytes, (error, read) => {
      if (error) return next(error);

      let result;
      let shaped;
      try {
        // The caller's policy reaches the shaping, or this adapter would always report the socket peer
        // even where its caller declared a trusted front end.
        shaped = fromNodeRequest(req, read.text, { trustedProxy: options.trustedProxy }); // never crash
        if (read.overflow) notify(options.onSkip, { phase: 'request', reason: 'body-cap' }, 'onSkip');
        if (read.failed) notify(options.onSkip, { phase: 'request', reason: 'read-failed' }, 'onSkip');
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

      // Expose the parsed body downstream so a body-parser isn't also required — unless the body was
      // longer than the cap, when what was parsed is only its beginning and is not handed on as the body.
      if (!read.overflow && !read.failed) req.body = shaped.body;
      next();
    });
  };
}
