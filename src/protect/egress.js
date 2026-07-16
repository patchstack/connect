// Egress guard MECHANISM only. Wraps the app's outbound calls so they can be screened; the
// block DECISION is delegated to a caller-supplied `shouldBlock` predicate (which the runtime
// builds from egress-phase rules — see defaults.js). No policy is hardcoded here.
// WinterCG-first: always wraps the global `fetch` (Node 18+, Workers, Bun, Deno). On Node it
// ALSO patches `node:http`/`node:https` so outbound calls made via those modules (axios, got,
// the raw http client, …) — which never touch `fetch` — are screened too.

/**
 * @param {{ shouldBlock: (url:string, host:string|null, method:string)=>boolean,
 *           onBlock?: (info:{url:string,host:string|null,method:string})=>void,
 *           dnsScreen?: boolean,
 *           lookup?: Function }} opts
 * @returns {Promise<() => void>} uninstall (restores every patched surface)
 */
export async function installEgressGuard({ shouldBlock, onBlock, dnsScreen = true, lookup } = {}) {
  const restores = [];
  if (typeof shouldBlock !== 'function') return () => {};

  const block = (url, host, method) => {
    if (!shouldBlock(url, host, method)) return false;
    onBlock?.({ url, host, method });
    return true;
  };

  // 1. global fetch — synchronous, so it's active the instant this returns (no startup race).
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function' && !originalFetch.__patchstackGuarded) {
    const guarded = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      let host = null;
      try {
        host = new URL(url).hostname;
      } catch {
        host = null;
      }
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (block(url, host, method)) {
        throw new Error(`Patchstack blocked an outbound request to a disallowed address: ${host ?? url}`);
      }
      return originalFetch(input, init);
    };
    guarded.__patchstackGuarded = true;
    globalThis.fetch = guarded;
    restores.push(() => {
      if (globalThis.fetch === guarded) globalThis.fetch = originalFetch;
    });
  }

  // DNS-rebinding screen for the Node http path: instead of trusting the hostname, resolve it
  // ourselves, block if it maps to a disallowed address, and PIN the connection to that vetted
  // resolution — so a name that passes the hostname check but resolves (or re-resolves) to an
  // internal/metadata IP can't slip through (time-of-check vs time-of-use). Needs node:dns +
  // node:net; absent on edge runtimes, where the hostname rules still apply.
  let screen = null;
  if (dnsScreen) {
    try {
      const resolveLookup = lookup ?? (await import('node:dns')).lookup;
      const { isIP } = await import('node:net');
      if (typeof resolveLookup === 'function' && typeof isIP === 'function') {
        screen = { lookup: resolveLookup, isIP };
      }
    } catch {
      screen = null; // no node:dns/net here — skip, hostname rules still apply
    }
  }

  // node:http / node:https — best-effort; absent on Workers/Deno-without-node (import throws).
  for (const moduleName of ['node:http', 'node:https']) {
    try {
      const mod = await import(moduleName);
      const restore = patchHttpModule(mod.default ?? mod, block, screen);
      if (restore) restores.push(restore);
    } catch {
      /* module not available on this runtime — skip */
    }
  }

  // 3. global WebSocket — ws:// / wss:// egress that never touches fetch or node:http.
  const OriginalWS = globalThis.WebSocket;
  if (typeof OriginalWS === 'function' && !OriginalWS.__patchstackGuarded) {
    const GuardedWS = new Proxy(OriginalWS, {
      construct(target, args, newTarget) {
        const url = String(args?.[0] ?? '');
        let host = null;
        try {
          host = new URL(url).hostname;
        } catch {
          host = null;
        }
        if (block(url, host, 'WEBSOCKET')) {
          throw new Error(`Patchstack blocked an outbound WebSocket to a disallowed address: ${host ?? url}`);
        }
        return Reflect.construct(target, args, newTarget);
      },
    });
    OriginalWS.__patchstackGuarded = true; // marker on the original guards against double-wrap
    globalThis.WebSocket = GuardedWS;
    restores.push(() => {
      if (globalThis.WebSocket === GuardedWS) globalThis.WebSocket = OriginalWS;
      delete OriginalWS.__patchstackGuarded;
    });
  }

  return () => {
    for (const restore of restores) {
      try {
        restore();
      } catch {
        /* ignore */
      }
    }
  };
}

// Wrap http(s).request/get so a blocked destination throws before the socket opens.
function patchHttpModule(http, block, screen) {
  if (!http || typeof http.request !== 'function' || http.__patchstackGuarded) return null;
  const originalRequest = http.request;
  const originalGet = http.get;

  const wrap = (original) =>
    function (...args) {
      const target = extractHttpTarget(args);
      if (target && block(target.url, target.host, target.method)) {
        throw new Error(`Patchstack blocked an outbound request to a disallowed address: ${target.host ?? target.url}`);
      }
      // DNS screen: only for real hostnames (a literal IP was already covered by the check above).
      if (target && screen && target.host && screen.isIP(target.host) === 0) {
        try {
          args = withScreeningLookup(args, target, block, screen.lookup);
        } catch {
          /* injection failed — proceed unscreened (fail-open) */
        }
      }
      return original.apply(this, args);
    };

  http.request = wrap(originalRequest);
  if (typeof originalGet === 'function') http.get = wrap(originalGet);
  http.__patchstackGuarded = true;

  return () => {
    http.request = originalRequest;
    if (typeof originalGet === 'function') http.get = originalGet;
    delete http.__patchstackGuarded;
  };
}

// http.request accepts (url), (url, options), or (options) — with an optional trailing callback.
function extractHttpTarget(args) {
  const first = args[0];
  try {
    if (typeof first === 'string' || first instanceof URL) {
      const url = new URL(String(first));
      const opts = args.find((a) => a && typeof a === 'object' && !(a instanceof URL));
      return { url: url.href, host: url.hostname, method: (opts && opts.method) || 'GET' };
    }
    if (first && typeof first === 'object') {
      const host = normalizeHost(first.hostname || first.host);
      const protocol = first.protocol || 'http:';
      const port = first.port ? `:${first.port}` : '';
      const path = first.path || '/';
      return { url: `${protocol}//${host}${port}${path}`, host, method: first.method || 'GET' };
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Extract the bare host from a node http(s) options `host`/`hostname`, WITHOUT mangling IPv6.
// `[::1]:8080` → `::1`, bare `::1`/`fe80::1` → unchanged, `example.com:443` → `example.com`.
// (isInternalHost strips brackets and matches ::1 / fe80: / fc / fd, so this must not corrupt them.)
function normalizeHost(raw) {
  const host = String(raw || '').trim();
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  if (bracketed) return bracketed[1];
  if ((host.match(/:/g) || []).length > 1) return host; // bare IPv6 — no host:port to split
  return host.split(':')[0];
}

// Given the addresses a hostname resolved to, return the first one the policy blocks (else null).
// Reuses the same `block` predicate as the hostname check, so egress rules + allowlist apply to
// the resolved IP too. Exported for tests.
export function screenResolved(addresses, target, block) {
  for (const a of addresses || []) {
    const ip = a && typeof a === 'object' ? a.address : a;
    if (ip && block(target.url, ip, target.method)) return ip;
  }
  return null;
}

// Build a DNS `lookup` that screens every resolved address before the socket connects, then hands
// back the vetted addresses (pinning the connection to what we checked). A blocked address errors
// the connection; a resolver error or our own failure falls through to normal resolution (fail-open).
function withScreeningLookup(args, target, block, lookup) {
  const screeningLookup = (hostname, options, callback) => {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (!opts || typeof opts !== 'object') opts = {};
    try {
      lookup(hostname, { ...opts, all: true }, (err, addresses) => {
        if (err) return cb(err);
        const list = Array.isArray(addresses) ? addresses : [];
        const blocked = screenResolved(list, target, block);
        if (blocked) {
          return cb(new Error(`Patchstack blocked an outbound request to a disallowed address: ${target.host} resolved to ${blocked}`));
        }
        if (opts.all) return cb(null, list);
        const first = list[0];
        if (!first) return cb(new Error(`Patchstack: could not resolve ${hostname}`));
        return cb(null, first.address, first.family);
      });
    } catch {
      // Our screening threw — fall back to a plain resolution so we never break a request ourselves.
      try {
        lookup(hostname, opts, cb);
      } catch {
        cb(new Error(`Patchstack: lookup failed for ${hostname}`));
      }
    }
  };
  return injectLookupOption(args, screeningLookup);
}

// Return a new args array for http(s).request with our `lookup` set on the options object (cloned,
// never mutating the caller's object), inserting an options object when the call didn't pass one.
function injectLookupOption(args, lookup) {
  const first = args[0];
  if (first && typeof first === 'object' && !(first instanceof URL)) {
    return [{ ...first, lookup }, ...args.slice(1)];
  }
  const rest = args.slice(1);
  const optIdx = rest.findIndex((a) => a && typeof a === 'object' && !(a instanceof URL));
  if (optIdx !== -1) {
    const next = [...rest];
    next[optIdx] = { ...rest[optIdx], lookup };
    return [first, ...next];
  }
  const cbIdx = rest.findIndex((a) => typeof a === 'function');
  if (cbIdx === -1) return [first, { lookup }, ...rest];
  return [first, ...rest.slice(0, cbIdx), { lookup }, ...rest.slice(cbIdx)];
}
