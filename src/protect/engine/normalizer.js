/**
 * Request Normalization Pipeline
 *
 * Normalizes request data to prevent encoding-based bypass attacks.
 * This module handles URL encoding, HTML entities, SQL comments, and other
 * obfuscation techniques that attackers use to evade pattern matching.
 */
import { setOwn } from './own.js';


const HTML_ENTITIES = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&#x27;': "'",
    '&#x22;': '"',
    '&#x3C;': '<',
    '&#x3E;': '>',
    '&#x26;': '&',
    '&#34;': '"',
    '&#60;': '<',
    '&#62;': '>',
    '&#38;': '&'
};

const MAX_DECODE_ITERATIONS = 5;

export function normalize(value, options = {}) {
    if (typeof value !== 'string') {
        return value;
    }

    const opts = {
        urlDecode: true,
        htmlDecode: true,
        sqlComments: true,
        nullBytes: true,
        whitespace: true,
        ...options
    };

    let result = value;

    if (opts.nullBytes) {
        result = removeNullBytes(result);
    }

    if (opts.urlDecode) {
        result = urlDecode(result);
    }

    if (opts.htmlDecode) {
        result = htmlEntityDecode(result);
    }

    if (opts.sqlComments) {
        result = removeSqlComments(result);
    }

    if (opts.whitespace) {
        result = normalizeWhitespace(result);
    }

    return result;
}

export function urlDecode(value) {
    if (typeof value !== 'string') {
        return value;
    }

    let result = value;
    let previous = '';
    let iterations = 0;

    while (result !== previous && iterations < MAX_DECODE_ITERATIONS) {
        previous = result;
        iterations++;

        try {
            result = decodeURIComponent(result);
        } catch {
            result = safeUrlDecode(result);
            break;
        }
    }

    return result;
}

function safeUrlDecode(value) {
    return value.replace(/%([0-9A-Fa-f]{2})/g, (match, hex) => {
        try {
            return String.fromCharCode(parseInt(hex, 16));
        } catch {
            return match;
        }
    });
}

export function htmlEntityDecode(value) {
    if (typeof value !== 'string') {
        return value;
    }

    let result = value;

    for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
        result = result.split(entity).join(char);
    }

    result = result.replace(/&#(\d+);/g, (match, code) => {
        const num = parseInt(code, 10);
        return num > 0 && num < 65536 ? String.fromCharCode(num) : match;
    });

    result = result.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
        const num = parseInt(hex, 16);
        return num > 0 && num < 65536 ? String.fromCharCode(num) : match;
    });

    return result;
}

export function removeSqlComments(value) {
    if (typeof value !== 'string') {
        return value;
    }

    // Collapse inline block comments to a space (the anti-obfuscation goal). We must NOT strip the
    // line-comment forms (`--…`, `#…`) to end-of-line: on the WAF inspection path that DELETES
    // attacker-controlled spans from the value the engine sees while the app still processes the
    // original — e.g. `#<script>…` becomes empty and evades an XSS rule, though the browser still
    // runs it. Keeping the content only ever ADDS matches (more of the value is inspected), never
    // hides one. SQLi keyword detection is unaffected — the keywords remain visible.
    let result = value;

    result = result.replace(/\/\*[\s\S]*?\*\//g, ' ');
    result = result.replace(/\/\*![\s\S]*?\*\//g, ' ');

    return result;
}

export function removeNullBytes(value) {
    if (typeof value !== 'string') {
        return value;
    }

    let result = value.replace(/\x00/g, '');

    result = result.replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '');

    return result;
}

export function normalizeWhitespace(value) {
    if (typeof value !== 'string') {
        return value;
    }

    let result = value.replace(/[\t\r\n\f\v]+/g, ' ');

    result = result.replace(/ {2,}/g, ' ');

    return result;
}

const MAX_RAW_CHARS = 1024 * 1024;
const MAX_RAW_NODES = 25_000;
const MAX_RAW_DEPTH = 200;
const MAX_RAW_ENTRIES = 2_000;

function serializeForRawDetection(body) {
    if (body === null || body === undefined) return '';
    if (typeof body === 'string') return body.slice(0, MAX_RAW_CHARS);

    const visited = new Set();
    const output = [];
    const stack = [{ kind: 'value', value: body, depth: 0, root: true }];
    let chars = 0;
    let nodes = 0;

    const append = (text) => {
        if (chars >= MAX_RAW_CHARS) return;
        const piece = String(text).slice(0, MAX_RAW_CHARS - chars);
        output.push(piece);
        chars += piece.length;
    };

    while (stack.length > 0 && chars < MAX_RAW_CHARS) {
        const task = stack.pop();
        if (task.kind === 'text') {
            append(task.text);
            continue;
        }
        if (task.kind === 'key') {
            append(boundedJsonString(task.value));
            append(':');
            continue;
        }

        nodes++;
        if (nodes > MAX_RAW_NODES) {
            append('"[NodeLimit]"');
            continue;
        }

        const value = task.value;
        if (value === null || value === undefined) {
            append(task.root ? '' : 'null');
            continue;
        }
        if (typeof value === 'string') {
            append(task.root ? value.slice(0, MAX_RAW_CHARS) : boundedJsonString(value));
            continue;
        }
        if (typeof value !== 'object') {
            append(String(value).slice(0, MAX_RAW_CHARS));
            continue;
        }
        if (visited.has(value)) {
            append('[Circular]');
            continue;
        }
        if (task.depth >= MAX_RAW_DEPTH) {
            append('"[DepthLimit]"');
            continue;
        }
        visited.add(value);

        if (Array.isArray(value)) {
            const length = Math.min(value.length, MAX_RAW_ENTRIES);
            const items = [];
            for (let i = 0; i < length; i++) {
                if (i > 0) items.push({ kind: 'text', text: ',' });
                items.push({ kind: 'value', value: readOwnValue(value, String(i)), depth: task.depth + 1, root: false });
            }
            if (value.length > length) {
                if (length > 0) items.push({ kind: 'text', text: ',' });
                items.push({ kind: 'text', text: '"[EntryLimit]"' });
            }
            stack.push({ kind: 'text', text: ']' });
            for (let i = items.length - 1; i >= 0; i--) stack.push(items[i]);
            stack.push({ kind: 'text', text: '[' });
            continue;
        }

        let keys;
        try {
            // Includes non-enumerable own properties, including an own `__proto__` key.
            keys = Object.getOwnPropertyNames(value);
        } catch {
            append('"[Unreadable]"');
            continue;
        }
        const length = Math.min(keys.length, MAX_RAW_ENTRIES);
        const entries = [];
        for (let i = 0; i < length; i++) {
            const key = keys[i];
            if (i > 0) entries.push({ kind: 'text', text: ',' });
            // Defer stringifying the key until it reaches the output. A wide object with very long
            // names should not allocate rendered copies for siblings that the output cap will omit.
            entries.push({ kind: 'key', value: key });
            entries.push({ kind: 'value', value: readOwnValue(value, key), depth: task.depth + 1, root: false });
        }
        if (keys.length > length) {
            if (length > 0) entries.push({ kind: 'text', text: ',' });
            entries.push({ kind: 'text', text: '"[EntryLimit]":null' });
        }
        stack.push({ kind: 'text', text: '}' });
        for (let i = entries.length - 1; i >= 0; i--) stack.push(entries[i]);
        stack.push({ kind: 'text', text: '{' });
    }

    return output.join('');
}

function boundedJsonString(value) {
    return JSON.stringify(String(value).slice(0, MAX_RAW_CHARS));
}

function readOwnValue(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : '[Accessor]';
    } catch {
        return '[Unreadable]';
    }
}

// The only fields a supported framework supplies through an inherited accessor: `headers` is a getter on
// `IncomingMessage.prototype`, and Express defines `query` on its request prototype. Every other field
// arrives as an own property — body parsers, cookie parsers and upload middleware all assign one, and the
// Node and Fetch adapters build their request shape as a literal.
const INHERITED_ACCESSORS = new Set(['headers', 'query']);

/**
 * A request field, taken only from the request itself.
 *
 * Evidence is what a request actually carried. A value reachable only through a prototype was carried by
 * nothing, and materialising it would let one write stand as request data and fire every rule that
 * matches it — arriving indistinguishable from a real body, query or header.
 *
 * An own property is evidence. Everything inherited is refused, with one exception: a getter on a
 * prototype, for the two fields above. That exception exists because requiring an own property would
 * discard how Node and Express really expose headers and the query string, and silently stop screening
 * the sources rules read most — a worse failure than the pollution it prevents.
 *
 * The exception is deliberately narrow in both directions. An inherited DATA property is refused however
 * it arrives, because a framework does not install request data that way and a write to a prototype does;
 * and `Object.prototype` is refused even for an accessor, because that is where a pollution primitive
 * lands.
 */
export function requestField(req, key) {
    if (req === null || typeof req !== 'object') return undefined;
    if (Object.hasOwn(req, key)) return req[key];
    if (!INHERITED_ACCESSORS.has(key)) return undefined;

    let holder = Object.getPrototypeOf(req);
    while (holder !== null && !Object.hasOwn(holder, key)) holder = Object.getPrototypeOf(holder);
    if (holder === null || holder === Object.prototype) return undefined;

    // An accessor, not a value parked on a prototype the request happens to inherit from.
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);
    if (typeof descriptor?.get !== 'function') return undefined;

    // Read through `req` so the accessor runs with the receiver it expects.
    return req[key];
}

export function normalizeRequest(req, options = {}) {
    // Prefer a caller-provided verbatim body string (set by the fetch/node adapters):
    // it preserves literal keys like `__proto__` that JSON.stringify drops, which is
    // what makes prototype-pollution rules on `raw` robust. Fall back to a
    // reconstruction from the parsed body (the Express path, which has no raw text).
    // Own property only: a `_rawBody` reachable through a polluted prototype is not something this
    // request carried, and accepting it here would let it stand as verbatim evidence on every path.
    const ownRaw = Object.hasOwn(req ?? {}, '_rawBody') && typeof req._rawBody === 'string';
    // Every field below comes through the same gate, because the reconstruction fallback reads the parsed
    // body: gating `_rawBody` alone would leave a polluted `body` serialised into raw evidence anyway.
    const body = requestField(req, 'body');
    const url = requestField(req, 'url');
    const rawBody = ownRaw
        ? req._rawBody
        : serializeForRawDetection(body ?? null);

    return {
        query: normalizeObject(requestField(req, 'query') || {}, options),
        body: normalizeObject(body || {}, options),
        headers: normalizeObject(requestField(req, 'headers') || {}, options),
        url: normalize(url || '', options),
        originalUrl: normalize(requestField(req, 'originalUrl') || url || '', options),
        _rawBody: rawBody
    };
}

// Depth bound for the recursive walk: a pathologically deep object would otherwise overflow the
// stack, and the engine's per-rule catch would swallow that into a fail-open. Beyond the bound the
// sub-value is left un-normalized (still matched, just in its raw form) rather than crashing.
const MAX_NORMALIZE_DEPTH = 200;

export function normalizeObject(value, options = {}, depth = 0) {
    if (typeof value === 'string') {
        return normalize(value, options);
    }

    if (depth >= MAX_NORMALIZE_DEPTH) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(item => normalizeObject(item, options, depth + 1));
    }

    if (typeof value === 'object' && value !== null) {
        const result = {};

        for (const [key, val] of Object.entries(value)) {
            setOwn(result, key, normalizeObject(val, options, depth + 1));
        }

        return result;
    }

    return value;
}

export function createMatchVariants(value) {
    if (typeof value !== 'string') {
        return [value];
    }

    const variants = new Set();

    variants.add(value);

    const urlDecoded = urlDecode(value);
    variants.add(urlDecoded);

    const htmlDecoded = htmlEntityDecode(value);
    variants.add(htmlDecoded);

    const bothDecoded = htmlEntityDecode(urlDecoded);
    variants.add(bothDecoded);

    const normalized = normalize(value);
    variants.add(normalized);

    variants.add(value.toLowerCase());
    variants.add(normalized.toLowerCase());

    return Array.from(variants);
}

export const _testExports = {
    safeUrlDecode,
    serializeForRawDetection,
    HTML_ENTITIES,
    MAX_DECODE_ITERATIONS
};
