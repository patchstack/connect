// Resolvable DATA attributes of an uploaded file part (files.<name>.<attr>). The engine only exposes
// the raw data — WHAT counts as a malicious upload (signatures, type-vs-content mismatch) is expressed
// in rules (see the triage-vpatch-npm skill), not hardcoded here.
const FILE_ATTRS = new Set(['content', 'filename', 'type']);

// A captured file part is { filename, type, content }; tolerate the legacy bare-filename string.
const fileFilename = (f) => (f && typeof f === 'object' ? f.filename : f);
const fileAttribute = (f, attr) => (f && typeof f === 'object' ? f[attr] : attr === 'filename' ? f : undefined);

// WinterCG-safe base64 decode: use Buffer on Node, fall back to atob/TextDecoder on
// edge runtimes (Cloudflare Workers, Deno, Bun) where Buffer may be absent. Keeps the
// engine hot path free of Node-only APIs (per the ADR engine-language decision).
function base64DecodeUtf8(value) {
  const str = String(value);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'base64').toString('utf-8');
  }
  const binary = atob(str);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class RequestResolver {
  #req;
  #cookies;

  constructor(req) {
    this.#req = req;
    this.#cookies = null;
  }

  resolve(parameter) {
    if (!parameter || parameter === 'false') {
      return [null];
    }

    if (parameter === 'rules') {
      return [null];
    }

    if (parameter === 'raw') {
      return this.#resolveRaw();
    }

    if (parameter === 'all') {
      return this.#resolveAll();
    }

    const dotIndex = parameter.indexOf('.');
    if (dotIndex === -1) {
      return [];
    }

    const source = parameter.substring(0, dotIndex);
    const key = parameter.substring(dotIndex + 1);

    switch (source) {
      case 'get':
        return this.#resolveGet(key);
      case 'post':
        return this.#resolvePost(key);
      case 'request':
        return this.#resolveRequest(key);
      case 'cookie':
        return this.#resolveCookie(key);
      case 'server':
        return this.#resolveServer(key);
      case 'files':
        return this.#resolveFiles(key);
      case 'response':
        return this.#resolveResponse(key);
      case 'egress':
        return this.#resolveEgress(key);
      default:
        return [];
    }
  }

  // Response-phase sources (req._response = { status, headers, body }). Lets rules inspect
  // what the app is about to SEND — e.g. a leaked secret in the body — regardless of route.
  #resolveResponse(key) {
    const resp = this.#req._response;
    if (!resp) {
      return [];
    }
    if (key === 'status') {
      return resp.status !== undefined ? [String(resp.status)] : [];
    }
    if (key === 'body') {
      return resp.body != null && resp.body !== '' ? [resp.body] : [];
    }
    if (key === 'headers') {
      const headers = resp.headers ?? {};
      return [Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')];
    }
    if (key.startsWith('header.')) {
      const name = key.slice('header.'.length).toLowerCase();
      const value = (resp.headers ?? {})[name];
      return value !== undefined ? [value] : [];
    }
    return [];
  }

  // Egress-phase sources (req._egress = { url, host, method }). Lets rules inspect an
  // OUTBOUND request the app is about to make — SSRF at the egress boundary.
  #resolveEgress(key) {
    const eg = this.#req._egress;
    if (!eg) {
      return [];
    }
    if (key === 'url') return eg.url ? [eg.url] : [];
    if (key === 'host') return eg.host ? [eg.host] : [];
    if (key === 'method') return eg.method ? [eg.method] : [];
    return [];
  }

  applyMutations(mutations, value) {
    if (!mutations || !Array.isArray(mutations)) {
      return value;
    }

    let result = value;

    for (const mutation of mutations) {
      result = this.#applyMutation(mutation, result);
    }

    return result;
  }

  #applyMutation(mutation, value) {
    if (value === null || value === undefined) {
      return value;
    }

    switch (mutation) {
      case 'base64_decode':
        try {
          return base64DecodeUtf8(value);
        } catch {
          return value;
        }

      case 'json_decode':
        try {
          return JSON.parse(String(value));
        } catch {
          return value;
        }

      case 'json_encode':
        try {
          return JSON.stringify(value);
        } catch {
          return value;
        }

      case 'urldecode':
        try {
          return decodeURIComponent(String(value));
        } catch {
          return value;
        }

      case 'intval':
        return parseInt(String(value), 10) || 0;

      case 'getArrayValues':
        if (typeof value === 'object' && value !== null) {
          return Object.values(value);
        }
        return value;

      default:
        return value;
    }
  }

  #resolveGet(key) {
    const query = this.#req.query ?? {};

    if (key.endsWith('*')) {
      return this.#resolveWildcard(query, key);
    }

    const value = this.#getNestedValue(query, key);
    return value !== undefined ? [value] : [];
  }

  #resolvePost(key) {
    const body = this.#req.body ?? {};

    if (key.endsWith('*')) {
      return this.#resolveWildcard(body, key);
    }

    const value = this.#getNestedValue(body, key);
    return value !== undefined ? [value] : [];
  }

  #resolveRequest(key) {
    const query = this.#req.query ?? {};
    const body = this.#req.body ?? {};
    const cookies = this.#parseCookies();

    if (key.endsWith('*')) {
      return [
        ...this.#resolveWildcard(query, key),
        ...this.#resolveWildcard(body, key),
        ...this.#resolveWildcard(cookies, key)
      ];
    }

    const value = this.#getNestedValue(query, key)
      ?? this.#getNestedValue(body, key)
      ?? cookies[key];

    return value !== undefined ? [value] : [];
  }

  #resolveCookie(key) {
    const cookies = this.#parseCookies();

    if (key.endsWith('*')) {
      return this.#resolveWildcard(cookies, key);
    }

    const value = cookies[key];
    return value !== undefined ? [value] : [];
  }

  #resolveServer(key) {
    const req = this.#req;

    switch (key) {
      case 'REQUEST_URI':
        return [req.originalUrl ?? req.url ?? '/'];
      case 'REQUEST_METHOD':
        return [req.method ?? 'GET'];
      case 'HTTP_USER_AGENT':
        return req.headers?.['user-agent'] ? [req.headers['user-agent']] : [];
      case 'HTTP_REFERER':
        return req.headers?.referer ? [req.headers.referer] : [];
      case 'HTTP_HOST':
        return req.headers?.host ? [req.headers.host] : [];
      case 'REMOTE_ADDR':
      case 'ip':
        return [req.ip ?? req.socket?.remoteAddress ?? ''];
      case 'CONTENT_TYPE':
        return req.headers?.['content-type'] ? [req.headers['content-type']] : [];
      case 'CONTENT_LENGTH':
        return req.headers?.['content-length'] ? [req.headers['content-length']] : [];
      default: {
        if (key.startsWith('HTTP_')) {
          const headerName = key.substring(5).toLowerCase().replace(/_/g, '-');
          return req.headers?.[headerName] ? [req.headers[headerName]] : [];
        }
        return [];
      }
    }
  }

  #resolveFiles(key) {
    const files = this.#req.files;
    if (!files || typeof files !== 'object') {
      return [];
    }

    // files.<name>.<attr> — content | filename | type. Fans out over multiple files uploaded under
    // the same field name.
    const dot = key.lastIndexOf('.');
    if (dot !== -1 && FILE_ATTRS.has(key.slice(dot + 1)) && Object.prototype.hasOwnProperty.call(files, key.slice(0, dot))) {
      const attr = key.slice(dot + 1);
      const entry = files[key.slice(0, dot)];
      const list = Array.isArray(entry) ? entry : [entry];
      const out = [];
      for (const f of list) {
        const v = fileAttribute(f, attr);
        if (v !== undefined && v !== '') out.push(v);
      }
      return out;
    }

    // Bare files.<name> (or wildcard) → the filename(s), preserving the legacy behavior that
    // filename-scoped rules rely on (the parser now stores a { filename, type, content } object).
    const filenamesOf = (entry) => (Array.isArray(entry) ? entry.map(fileFilename) : [fileFilename(entry)]);
    if (key.endsWith('*')) {
      const prefix = key.slice(0, -1);
      const out = [];
      for (const [k, entry] of Object.entries(files)) {
        if (k.startsWith(prefix)) out.push(...filenamesOf(entry));
      }
      return out.filter((v) => v !== undefined);
    }
    if (!Object.prototype.hasOwnProperty.call(files, key)) return [];
    return filenamesOf(files[key]).filter((v) => v !== undefined);
  }

  #resolveRaw() {
    // Use pre-captured raw body if available (set by normalizeRequest).
    // For string bodies, the original text is preserved verbatim.
    // For pre-parsed objects, serializeForRawDetection uses Object.getOwnPropertyNames()
    // to include __proto__ own-property keys that JSON.stringify() would silently drop.
    if (typeof this.#req._rawBody === 'string') {
      return this.#req._rawBody ? [this.#req._rawBody] : [];
    }

    const body = this.#req.body;

    if (body === undefined || body === null) {
      return [];
    }

    if (typeof body === 'string') {
      return [body];
    }

    try {
      return [JSON.stringify(body)];
    } catch {
      return [String(body)];
    }
  }

  #resolveAll() {
    const parts = [];

    const uri = this.#req.originalUrl ?? this.#req.url ?? '/';
    parts.push(uri);

    const queryString = uri.includes('?') ? uri.split('?')[1] : '';
    if (queryString) {
      parts.push(queryString);
    }

    const body = this.#req.body;
    if (body) {
      parts.push(typeof body === 'string' ? body : JSON.stringify(body));
    }

    const headers = this.#req.headers ?? {};
    const excludedHeaders = new Set([
      'host', 'connection', 'cache-control', 'accept', 'accept-encoding',
      'accept-language', 'priority', 'sec-ch-ua', 'sec-ch-ua-mobile',
      'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode',
      'sec-fetch-site', 'sec-fetch-user', 'upgrade-insecure-requests'
    ]);

    for (const [name, value] of Object.entries(headers)) {
      if (!excludedHeaders.has(name)) {
        parts.push(`${name}: ${value}`);
      }
    }

    const cookies = this.#parseCookies();
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookieStr) {
      parts.push(cookieStr);
    }

    return [parts.join(' ')];
  }

  #resolveWildcard(obj, pattern) {
    if (typeof obj !== 'object' || obj === null) {
      return [];
    }

    const prefix = pattern.slice(0, -1);
    const values = [];

    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith(prefix)) {
        values.push(value);
      }
    }

    return values;
  }

  #getNestedValue(obj, key) {
    if (typeof obj !== 'object' || obj === null) {
      return undefined;
    }

    // Own-property only: `key in obj` would resolve `__proto__`/`constructor`/`toString` to the
    // prototype chain, so a rule like `post.__proto__` (detecting a literal `__proto__` field) would
    // read Object.prototype instead of request data and never match. Use hasOwnProperty.
    const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

    if (own(obj, key)) {
      return obj[key];
    }

    const parts = key.split('.');
    let current = obj;

    for (const part of parts) {
      if (!own(current, part)) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  #parseCookies() {
    if (this.#cookies !== null) {
      return this.#cookies;
    }

    if (this.#req.cookies) {
      this.#cookies = this.#req.cookies;
      return this.#cookies;
    }

    const header = this.#req.headers?.cookie;
    if (!header) {
      this.#cookies = {};
      return this.#cookies;
    }

    const cookies = {};

    for (const pair of header.split(';')) {
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) {
        continue;
      }
      const name = pair.substring(0, eqIndex).trim();
      const value = pair.substring(eqIndex + 1).trim();
      cookies[name] = value;
    }

    this.#cookies = cookies;
    return this.#cookies;
  }
}
