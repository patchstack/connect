// Egress guard MECHANISM only. Wraps the app's outbound calls so they can be screened; the
// block DECISION is delegated to a caller-supplied `shouldBlock` predicate (which the runtime
// builds from egress-phase rules — see defaults.js). No policy is hardcoded here.
// WinterCG-first: always wraps the global `fetch` (Node 18+, Workers, Bun, Deno). On Node it
// ALSO patches `node:http`/`node:https` so outbound calls made via those modules (axios, got,
// the raw http client, …) — which never touch `fetch` — are screened too.

/**
 * @param {{ shouldBlock: (url:string, host:string|null, method:string)=>boolean,
 *           onBlock?: (info:{url:string,host:string|null,method:string})=>void }} opts
 * @returns {Promise<() => void>} uninstall (restores every patched surface)
 */
export async function installEgressGuard({ shouldBlock, onBlock } = {}) {
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

  // 2. node:http / node:https — best-effort; absent on Workers/Deno-without-node (import throws).
  for (const moduleName of ['node:http', 'node:https']) {
    try {
      const mod = await import(moduleName);
      const restore = patchHttpModule(mod.default ?? mod, block);
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
function patchHttpModule(http, block) {
  if (!http || typeof http.request !== 'function' || http.__patchstackGuarded) return null;
  const originalRequest = http.request;
  const originalGet = http.get;

  const wrap = (original) =>
    function (...args) {
      const target = extractHttpTarget(args);
      if (target && block(target.url, target.host, target.method)) {
        throw new Error(`Patchstack blocked an outbound request to a disallowed address: ${target.host ?? target.url}`);
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
