import { parseCookieHeader } from './cookies.js';
import { decodeHtmlEntities, safeUrlDecode, REQUEST_PATH } from './normalizer.js';
import { setOwn } from './own.js';

// Resolvable DATA attributes of an uploaded file part (files.<name>.<attr>). The engine only exposes
// the raw data — WHAT counts as a malicious upload (signatures, type-vs-content mismatch) is expressed
// in rules (see the triage-vpatch-npm skill), not hardcoded here.
const FILE_ATTRS = new Set(['content', 'filename', 'type']);

const ownValue = (obj, key) =>
  obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;

/**
 * The spellings one field path can arrive under: as written (resolved as a nested path), in bracket
 * form as a flat key (`a.b` → `a[b]`, `a` → `a[]`), and — for a path written in bracket form — as the
 * nested path it expands to (`a[b]` → `a.b`, `a[]` → `a`).
 */
function fieldSpellings(key) {
  const spellings = [{ key, nested: true }];
  if (key.includes('[')) {
    const dotted = key.replace(/\[\]$/, '').replace(/\[([^\][]*)\]/g, '.$1');
    if (dotted !== key && dotted !== '' && !dotted.includes('[') && !dotted.includes(']')) {
      spellings.push({ key: dotted, nested: true });
    }
    return spellings;
  }
  const [head, ...rest] = key.split('.');
  const bracketed = head + rest.map((part) => `[${part}]`).join('');
  if (bracketed !== key) spellings.push({ key: bracketed, nested: false });
  spellings.push({ key: `${bracketed}[]`, nested: false });
  return spellings;
}

// A captured file part is { filename, type, content }; tolerate the legacy bare-filename string.
const fileFilename = (f) => (f && typeof f === 'object' ? f.filename : f);
const fileAttribute = (f, attr) => (f && typeof f === 'object' ? f[attr] : attr === 'filename' ? f : undefined);

// WinterCG-safe base64 decode: use Buffer on Node, fall back to atob/TextDecoder on
// edge runtimes (Cloudflare Workers, Deno, Bun) where Buffer may be absent. Keeps the
// engine hot path free of Node-only APIs (per the ADR engine-language decision).
export function base64DecodeUtf8(value) {
  const str = String(value);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'base64').toString('utf-8');
  }
  const binary = atob(str);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Mutations that decode one string into another.
const TEXT_MUTATIONS = new Set(['base64_decode', 'urldecode', 'htmlentitydecode']);

// Same bounds as the engine's leaf walk: beyond them a node is kept as it is, still matched undecoded.
const MAX_MAPPED_NODES = 20000;
const MAX_MAPPED_DEPTH = 1000;

/**
 * A copy of `root` with `fn` applied to every string leaf. Iterative and bounded, so an oversized or
 * deeply nested value cannot overflow the stack; a shared or cyclic node is copied once. `onLimit` is
 * called when a node past the bounds is kept as it is, with `fn` not applied inside it.
 */
function mapStringLeaves(root, fn, onLimit) {
  const copies = new Map();
  const copyOf = (node) => {
    const copy = Array.isArray(node) ? [] : {};
    copies.set(node, copy);
    return copy;
  };
  const top = copyOf(root);
  const stack = [[root, top, 0]];
  let visited = 0;
  while (stack.length) {
    const [node, copy, depth] = stack.pop();
    visited++;
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (typeof child === 'string') {
        setOwn(copy, key, fn(child));
      } else if (child === null || typeof child !== 'object') {
        setOwn(copy, key, child);
      } else if (copies.has(child)) {
        setOwn(copy, key, copies.get(child));
      } else if (depth + 1 >= MAX_MAPPED_DEPTH || visited + stack.length >= MAX_MAPPED_NODES) {
        setOwn(copy, key, child);
        onLimit();
      } else {
        const childCopy = copyOf(child);
        setOwn(copy, key, childCopy);
        stack.push([child, childCopy, depth + 1]);
      }
    }
  }
  return top;
}

export class RequestResolver {
  #req;
  #cookies;
  #skips = new Set();

  constructor(req) {
    this.#req = req;
    this.#cookies = null;
  }

  /** Record an inspection limit this evaluation reached (reported once per reason). */
  noteSkip(reason) {
    this.#skips.add(reason);
  }

  /** The inspection limits recorded so far, in the order first reached. */
  get skips() {
    return [...this.#skips];
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
      const headers = resp.headers ?? {};
      return Object.hasOwn(headers, name) ? [headers[name]] : [];
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

    // A text decoder applied to a structured value decodes each string inside it and keeps the structure,
    // so the matcher still sees every leaf.
    if (typeof value === 'object' && TEXT_MUTATIONS.has(mutation)) {
      // Past the walk's bounds the value is still matched, undecoded; that is reported like the leaf walk's.
      return mapStringLeaves(value, (leaf) => this.#applyMutation(mutation, leaf), () => this.noteSkip('container-cap'));
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
        // Form decoding: `+` is a space, and every well-formed escape is decoded even beside a stray `%`.
        return safeUrlDecode(String(value).replace(/\+/g, ' '));

      case 'htmlentitydecode':
        return decodeHtmlEntities(String(value));

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

    return this.#lookup(query, key);
  }

  #resolvePost(key) {
    const body = this.#req.body ?? {};

    if (key.endsWith('*')) {
      return this.#resolveWildcard(body, key);
    }

    return this.#lookup(body, key);
  }

  /**
   * Every value a field path names in `obj`, in either spelling a form or query field can take.
   *
   * A parser that expands brackets (`qs`, as Express uses) turns `user[name]=x` into `{ user: { name } }`
   * and `id[]=x` into `{ id: [x] }`; a flat parser (`URLSearchParams`, as the Fetch and Node adapters use)
   * keeps `user[name]` and `id[]` as literal keys. The rule names the field once, so both shapes answer
   * to both spellings: `user.name` and `user[name]`, `id` and `id[]`.
   */
  #lookup(obj, key) {
    const values = [];
    for (const candidate of fieldSpellings(key)) {
      const value = candidate.nested ? this.#getNestedValue(obj, candidate.key) : ownValue(obj, candidate.key);
      if (value !== undefined) values.push(value);
    }
    return values;
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

    const fromQuery = this.#lookup(query, key);
    if (fromQuery.length > 0) return fromQuery;
    const fromBody = this.#lookup(body, key);
    if (fromBody.length > 0) return fromBody;

    return Object.hasOwn(cookies, key) ? [cookies[key]] : [];
  }

  #resolveCookie(key) {
    const cookies = this.#parseCookies();

    if (key.endsWith('*')) {
      return this.#resolveWildcard(cookies, key);
    }

    return Object.hasOwn(cookies, key) ? [cookies[key]] : [];
  }

  #resolveServer(key) {
    const req = this.#req;

    switch (key) {
      case 'REQUEST_URI':
        return [req.originalUrl ?? req.url ?? '/'];
      case 'REQUEST_PATH':
        return Object.hasOwn(req, REQUEST_PATH) && typeof req[REQUEST_PATH] === 'string'
          ? [req[REQUEST_PATH]] : [];
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
        // The address the caller resolved, and nothing else. Falling back to the socket — or to a
        // forwarded header — would let one request be attributed to two different addresses depending on
        // which consumer asked, and would reintroduce a value the client can set.
        return [typeof req.ip === 'string' ? req.ip : ''];
      case 'CONTENT_TYPE':
        return req.headers?.['content-type'] ? [req.headers['content-type']] : [];
      case 'CONTENT_LENGTH':
        return req.headers?.['content-length'] ? [req.headers['content-length']] : [];
      default: {
        if (key.startsWith('HTTP_')) {
          const headerName = key.substring(5).toLowerCase().replace(/_/g, '-');
          const headers = req.headers;
          // Presence, not truthiness. A header sent with an empty value IS present, and an `isset`
          // rule authored against it must see it — some bypasses are carried by the header existing
          // at all, so treating `Header:` as absent would make the rule quietly miss the shape it
          // was written for. (The named cases above keep value semantics: for host/origin/referer an
          // empty string and an absent header mean the same thing to the matchers that read them.)
          if (headers === null || typeof headers !== 'object') return [];
          return Object.prototype.hasOwnProperty.call(headers, headerName) ? [headers[headerName]] : [];
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
    // Also fold in the verbatim body: a body the adapter couldn't structurally parse (an unusual
    // content-type, a non-JSON payload) leaves `body` empty, but the raw text must still be matchable
    // by an `all` rule — otherwise it's only visible via `raw`.
    if (typeof this.#req._rawBody === 'string' && this.#req._rawBody) {
      parts.push(this.#req._rawBody);
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

    this.#cookies = parseCookieHeader(this.#req.headers?.cookie);
    return this.#cookies;
  }
}
