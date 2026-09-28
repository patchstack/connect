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
 * @returns {Promise<() => void>} uninstall (removes this screen; the last one out restores the patched surfaces)
 */
import { notify } from './notify.js';

// fetch and node:http(s) are process-wide, so the guard on them is too: one wrapper per surface, shared
// by every protection in the process (including another copy of this package), each registering its own
// screen. A call is refused when any registered screen refuses it. Keyed on a global symbol so that two
// copies of this module share one registry rather than each deciding the other's wrapper is enough.
const REGISTRY = Symbol.for('patchstack.connect.egress-guard');

function egressRegistry() {
  const existing = globalThis[REGISTRY];
  if (existing && existing.screens instanceof Set && existing.surfaces instanceof Map) return existing;
  const created = { screens: new Set(), surfaces: new Map() };
  Object.defineProperty(globalThis, REGISTRY, { value: created, configurable: true, writable: true });
  return created;
}

const refusal = (host) => new Error(`Patchstack blocked an outbound request to a disallowed address: ${host}`);

// The destination of a fetch call whose arguments `Request` would not accept, when one can be read: a
// URL string, a URL object, or an object carrying `url`/`href`. Null when there is no parseable URL.
function readableDestination(input, init) {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url ?? input?.href;
    if (typeof raw !== 'string' && !(raw instanceof URL)) return null;
    const url = new URL(String(raw)).href;
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    return { url, method };
  } catch {
    return null;
  }
}

// Asks every screen, so each one reports its own refusal, then answers whether any refused.
function anyRefuses(screens, url, host, method) {
  let refused = false;
  for (const screen of screens) {
    if (screen.block(url, host, method)) refused = true;
  }
  return refused;
}

export async function installEgressGuard({ shouldBlock, onBlock, onSkip, dnsScreen = true, lookup, allowHosts } = {}) {
  if (typeof shouldBlock !== 'function') return () => {};
  const exempt = new Set((allowHosts ?? []).map((h) => String(h).toLowerCase()));

  const block = (url, host, method) => {
    if (!shouldBlock(url, host, method)) return false;
    // Reported AFTER the decision and contained, because this call sits between deciding to block and
    // saying so. An escaping throw would replace a controlled block with the callback's exception, which
    // hands the enforcement outcome to reporting code — the inverse of what a block is for.
    notify(onBlock, { url, host, method }, 'onEgressBlock');
    return true;
  };

  // DNS resolution, shared by the fetch wrapper and the node http path. Instead of trusting the
  // hostname, resolve it and check the resolved address(es).
  //
  // What the node path establishes is about the resolutions it PERFORMS: when the injected resolver is
  // the one a connection resolves through, the socket gets the addresses that were screened and there
  // is no time-of-check/use gap. It is not a property of the module path as a whole, and this code
  // cannot tell which calls it holds for: an agent can hold its own resolver, a transport can connect
  // without consulting ours, and a keep-alive agent — which the stock global agent is — can reuse a
  // socket that was connected before any of this ran. So the guarantee is stated for what it covers
  // and claimed for nothing else.
  //
  // On fetch we can't pin at all without a custom undici dispatcher, so we screen the resolution and a
  // re-resolve at connect is a residual window.
  // Needs node:dns + node:net; absent on edge runtimes, where the hostname rules still apply.
  let screen = null;
  if (dnsScreen) {
    try {
      const resolveLookup = lookup ?? (await import('node:dns')).lookup;
      const { isIP } = await import('node:net');
      if (typeof resolveLookup === 'function' && typeof isIP === 'function') {
        screen = { lookup: resolveLookup, isIP, isExempt: (h) => exempt.has(String(h).toLowerCase()) };
      }
    } catch {
      screen = null; // no node:dns/net here — skip, hostname rules still apply
    }
  }

  // Coverage for the FETCH pre-screen below, its only caller. A resolver that is unavailable or fails
  // there means the call goes out screened by hostname and not by address — a real (if rare) hole, so it
  // is reported through onSkip rather than passed over. Still fail-open: a broken resolver must not take
  // the app's outbound traffic down.
  //
  // The node path does not come through here. Its resolver IS the connection's, so a failure there is
  // forwarded and nothing connects — no bypass, and nothing owed to this accounting.
  const skip = (reason, detail) => notify(onSkip, { phase: 'egress', reason, detail }, 'onSkip');

  // The fetch pre-screen: true when a hostname resolves to a disallowed address. Fail-open, so any
  // resolver error is false — and reported, since the call then goes out unscreened by address.
  const resolvesToDisallowed = (url, host, method) =>
    new Promise((resolve) => {
      if (!screen) {
        // No node:dns/net here (edge runtime) or screening disabled — hostname rules only.
        if (host && dnsScreen) skip('resolver-unavailable', { host });
        return resolve(false);
      }
      if (!host || screen.isIP(host) !== 0 || screen.isExempt(host)) return resolve(false);
      try {
        screen.lookup(host, { all: true }, (err, addresses) => {
          if (err || !Array.isArray(addresses)) { skip('resolver-failed', { host }); return resolve(false); }
          for (const a of addresses) {
            const ip = a && typeof a === 'object' ? a.address : a;
            if (ip && block(url, ip, method)) return resolve(true);
          }
          resolve(false);
        });
      } catch {
        skip('resolver-failed', { host });
        resolve(false);
      }
    });

  const registry = egressRegistry();
  const own = { block, prescreen: resolvesToDisallowed, dns: screen, skip };
  registry.screens.add(own);

  // 1. global fetch — synchronous install, so it's active the instant this returns (no startup race).
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function' && !originalFetch.__patchstackGuarded) {
    const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
    const MAX_REDIRECTS = 20;
    const MAX_REPLAY_BODY_BYTES = 1024 * 1024;

    const captureReplayBody = (request) => {
      if (request.method === 'GET' || request.method === 'HEAD' || !request.body) {
        return { result: Promise.resolve({ body: undefined, tooLarge: false }), cancel() {} };
      }

      let reader;
      try {
        reader = request.clone().body?.getReader();
      } catch {
        reader = null;
      }
      if (!reader) {
        return { result: Promise.resolve({ body: undefined, tooLarge: true }), cancel() {} };
      }

      let cancelled = false;
      const result = (async () => {
        const chunks = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;
            total += value.byteLength;
            if (total > MAX_REPLAY_BODY_BYTES) {
              void reader.cancel().catch(() => {});
              return { body: undefined, tooLarge: true };
            }
            chunks.push(value);
          }
          if (cancelled) return { body: undefined, tooLarge: false };
          const body = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return { body, tooLarge: false };
        } catch {
          return { body: undefined, tooLarge: true };
        } finally {
          reader.releaseLock();
        }
      })();

      return {
        result,
        cancel() {
          cancelled = true;
          void reader.cancel().catch(() => {});
        },
      };
    };

    const discardResponseBody = async (response) => {
      try {
        await response?.body?.cancel?.();
      } catch {
        // A redirect body is not returned to the caller, so cleanup failure does not change the hop.
      }
    };

    // Screen one outbound URL against every registered screen: hostname/allowlist/literal-IP check,
    // then a DNS-resolution check for real hostnames. Throws if any screen disallows the destination.
    const screenUrl = async (u, method) => {
      let host = null;
      try {
        host = new URL(u).hostname;
      } catch {
        host = null;
      }
      const screens = [...registry.screens];
      if (anyRefuses(screens, u, host, method)) throw refusal(host ?? u);
      const resolved = await Promise.all(screens.map((each) => each.prescreen(u, host, method)));
      if (resolved.includes(true)) throw refusal(host ?? u);
    };

    const guarded = async (input, init) => {
      let cur;
      try {
        cur = new Request(input, { ...(init || {}), redirect: 'manual' });
      } catch {
        // An input this runtime's Request refuses is handed to the underlying fetch as it came, which
        // decides whether it is a request at all. Its destination is still screened when it can be read;
        // when it cannot, the call goes out unscreened and is counted as such.
        const destination = readableDestination(input, init);
        if (destination) await screenUrl(destination.url, destination.method);
        else for (const each of registry.screens) each.skip('unrecognised-request', {});
        return originalFetch(input, init);
      }
      const callerRedirect = (init && init.redirect) || (input && input.redirect) || 'follow';

      let url = cur.url;
      let method = cur.method;
      await screenUrl(url, method);

      // Caller manages redirects itself (manual/error) → screen once, hand back the raw response.
      if (callerRedirect !== 'follow') return originalFetch(input, init);

      // Otherwise follow redirects ourselves so EVERY hop is screened. Native `follow` re-resolves
      // internally and would let a 3xx to an internal address slip past the initial check — SSRF via
      // an open redirect. Capture a bounded clone concurrently with the first request: most calls never
      // redirect, so their first byte must not wait for a complete request body, while 307/308 still have
      // a replayable body when it is small enough to retain.
      const headers = new Headers(cur.headers);
      const signal = cur.signal;
      const replay = captureReplayBody(cur);
      let body;

      for (let hop = 0; ; hop++) {
        let resp;
        try {
          resp = await originalFetch(
            hop === 0 ? cur : new Request(url, { method, headers, body, redirect: 'manual', signal }),
          );
        } catch (error) {
          replay.cancel();
          throw error;
        }
        const location = REDIRECT_STATUSES.has(resp.status) ? resp.headers.get('location') : null;
        if (!location) {
          replay.cancel();
          return resp;
        }
        await discardResponseBody(resp);
        if (hop >= MAX_REDIRECTS) {
          replay.cancel();
          throw new Error('Patchstack blocked an outbound request: too many redirects');
        }

        const next = new URL(location, url).href;
        // Fetch redirect semantics: 303, and 301/302 on a POST, become a bodyless GET.
        if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          replay.cancel();
          headers.delete('content-type');
          headers.delete('content-length');
        } else if (body === undefined && method !== 'GET' && method !== 'HEAD') {
          const captured = await replay.result;
          if (captured.tooLarge) {
            throw new Error(
              `Patchstack blocked a redirect that required replaying more than ${MAX_REPLAY_BODY_BYTES} bytes`,
            );
          }
          body = captured.body;
        }
        // Drop credentials on a cross-origin hop, mirroring the browser.
        if (new URL(next).origin !== new URL(url).origin) {
          headers.delete('authorization');
          headers.delete('cookie');
        }
        await screenUrl(next, method);
        url = next;
      }
    };
    guarded.__patchstackGuarded = true;
    globalThis.fetch = guarded;
    // Released only while it is still the global: a wrapper layered on top later (an APM agent, …)
    // keeps calling this one, which then stays registered and screens with whichever screens are
    // registered at the time — none, until a protection registers again.
    registry.surfaces.set(guarded, {
      release() {
        if (globalThis.fetch !== guarded) return false;
        globalThis.fetch = originalFetch;
        return true;
      },
    });
  }

  // node:http / node:https — best-effort; absent on Workers/Deno-without-node (import throws).
  //
  // The module object is what `require` returns and what a default import is, but a NAMED import
  // (`import { request } from 'node:http'`) and a namespace import are bindings to its exports, which
  // Node refreshes only when told to. So after patching, and again after restoring, the builtin ESM
  // exports are synced — which updates those bindings wherever they were imported, including before
  // this ran.
  let syncBuiltins = () => {};
  try {
    const { syncBuiltinESMExports } = await import('node:module');
    if (typeof syncBuiltinESMExports === 'function') syncBuiltins = syncBuiltinESMExports;
  } catch {
    /* no node:module on this runtime — nothing to sync */
  }
  let patchedAny = false;
  for (const moduleName of ['node:http', 'node:https']) {
    try {
      const mod = await import(moduleName);
      if (registry.surfaces.has(moduleName)) continue;
      const release = patchHttpModule(mod.default ?? mod, registry);
      if (release) {
        patchedAny = true;
        registry.surfaces.set(moduleName, {
          release() {
            if (!release()) return false;
            syncBuiltins();
            return true;
          },
        });
      }
    } catch {
      /* module not available on this runtime — skip */
    }
  }
  if (patchedAny) syncBuiltins();

  // WebSocket egress is intentionally NOT screened. The WebSocket constructor is synchronous, so
  // the only check possible inline is a textual hostname match — which cannot screen what a name
  // resolves to (a name that resolves to an internal address would pass). The fetch path screens the
  // resolution, and the node:http/https path also pins the connection to the screened address when
  // the connection resolves through it. The server-side, attacker-controlled-WebSocket sink is rare,
  // and a hostname-only check would over-promise the control. Outbound screening covers fetch and
  // node:http/https.

  // Removes this screen only. The last screen to leave releases the surfaces it can; one that is no
  // longer the outermost wrapper stays registered, screening nothing until a screen registers again.
  return () => {
    registry.screens.delete(own);
    if (registry.screens.size > 0) return;
    for (const [name, surface] of registry.surfaces) {
      try {
        if (surface.release()) registry.surfaces.delete(name);
      } catch {
        /* ignore */
      }
    }
  };
}

// Wrap http(s).request/get — and, on node:http, the ClientRequest constructor they build — so a
// blocked destination throws before the socket opens.
function patchHttpModule(http, registry) {
  if (!http || typeof http.request !== 'function' || http.__patchstackGuarded) return null;
  const originalRequest = http.request;
  const originalGet = http.get;
  const OriginalClientRequest = typeof http.ClientRequest === 'function' ? http.ClientRequest : null;

  // The arguments to hand on, after screening them. Throws when the destination is refused.
  const guardArgs = (args) => {
    const target = extractHttpTarget(args);
    if (!target) return args;
    const screens = [...registry.screens];
    if (anyRefuses(screens, target.url, target.host, target.method)) throw refusal(target.host ?? target.url);
    // DNS screen: only for real hostnames (a literal IP was already covered by the check above), and
    // not for a screen that allowlists this host (the operator trusts it — don't second-guess its DNS).
    // One resolution serves every screen that wants one, so the connection is pinned to addresses that
    // all of them checked; it goes through the resolver of the earliest of those screens.
    const resolving = target.host
      ? screens.filter((each) => each.dns && each.dns.isIP(target.host) === 0 && !each.dns.isExempt(target.host))
      : [];
    if (resolving.length > 0) {
      const block = (url, host, method) => anyRefuses(resolving, url, host, method);
      const skip = (reason, detail) => {
        for (const each of resolving) each.skip(reason, detail);
      };
      try {
        return withScreeningLookup(args, target, block, resolving[0].dns.lookup, skip);
      } catch {
        // The call goes on with the arguments it came with. Nothing is counted as a fail-open bypass:
        // the only thing here that can throw is reading the caller's options, and Node copies that
        // object itself before doing anything — so options this cannot read are options Node refuses
        // too, and no traffic was served unscreened to report.
      }
    }

    return args;
  };

  const wrap = (original) =>
    function (...args) {
      return original.apply(this, guardArgs(args));
    };

  const guardedRequest = wrap(originalRequest);
  http.request = guardedRequest;
  let guardedGet;
  if (typeof originalGet === 'function') {
    guardedGet = wrap(originalGet);
    http.get = guardedGet;
  }

  // `request` and `get` build their ClientRequest from Node's own internal reference, so wrapping the
  // exported constructor screens only a request an application constructs itself — never one twice.
  // It shares the original's prototype, so `instanceof http.ClientRequest` still holds for every
  // request, and a subclass still gets its own prototype through `new.target`.
  let GuardedClientRequest;
  if (OriginalClientRequest) {
    GuardedClientRequest = function ClientRequest(...args) {
      const screened = guardArgs(args);

      return new.target
        ? Reflect.construct(OriginalClientRequest, screened, new.target)
        : Reflect.construct(OriginalClientRequest, screened);
    };
    GuardedClientRequest.prototype = OriginalClientRequest.prototype;
    Object.setPrototypeOf(GuardedClientRequest, OriginalClientRequest);
    http.ClientRequest = GuardedClientRequest;
  }
  http.__patchstackGuarded = true;

  // Released only when every wrapper is still the module's own export — don't clobber a wrapper another
  // library (an APM agent, etc.) layered on top of us after install. Otherwise nothing is restored and
  // the module keeps calling through ours, so it is never left half-guarded.
  return () => {
    if (http.request !== guardedRequest) return false;
    if (guardedGet && http.get !== guardedGet) return false;
    if (GuardedClientRequest && http.ClientRequest !== GuardedClientRequest) return false;
    http.request = originalRequest;
    if (guardedGet) http.get = originalGet;
    if (GuardedClientRequest) http.ClientRequest = OriginalClientRequest;
    delete http.__patchstackGuarded;
    return true;
  };
}

/**
 * The destination a `request(url[, options][, cb])` / `request(options[, cb])` call connects to.
 *
 * Resolved the way Node resolves it: the URL's fields first, then every field the options object
 * carries on top — so an `options.hostname` or `port` beats the URL's. `hostname` beats `host`, and an
 * absent host is `localhost`.
 */
function extractHttpTarget(args) {
  const first = args[0];
  try {
    if (typeof first === 'string' || first instanceof URL) {
      const url = new URL(String(first));
      const opts = args.find((a) => a && typeof a === 'object' && !(a instanceof URL));

      return targetOf({ ...optionsFromUrl(url), ...(opts ?? {}) });
    }
    if (first && typeof first === 'object') return targetOf(first);
  } catch {
    /* fall through */
  }
  return null;
}

/** A URL's fields as the options Node derives from it. */
function optionsFromUrl(url) {
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const options = { protocol: url.protocol, hostname, path: `${url.pathname || '/'}${url.search}` };
  if (url.port !== '') options.port = Number(url.port);

  return options;
}

function targetOf(options) {
  const host = normalizeHost(options.hostname || options.host) || 'localhost';
  const protocol = options.protocol || 'http:';
  const port = options.port ? `:${options.port}` : '';
  const path = options.path || '/';
  const authority = host.includes(':') ? `[${host}]` : host;

  return { url: `${protocol}//${authority}${port}${path}`, host, method: options.method || 'GET' };
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
// back the vetted addresses (pinning the connection to what we checked). A blocked address errors the
// connection.
//
// Screening COMPOSES with a resolver on the caller's OPTIONS: a `lookup` there is the one this resolves
// through, so an app that brought its own keeps it and what gets screened is what that resolver
// answered. Replacing it would screen a resolution the app never asked for, and connect to an address
// its own resolver never returned.
//
// An AGENT is not reached from here, and cannot be: it can own resolution, or the whole connection, in
// ways a `lookup` on the request does not reach. Whether a given call resolved through this resolver is
// therefore not something this function knows, and nothing above claims it does.
//
// An error from that resolution is handed on as it arrived, so nothing connects and no coverage skip is
// owed — a skip is for a destination that WAS reached without its address being checked. A failure of
// OURS hands over the addresses that resolution already produced, so screening cannot be the thing that
// breaks a request that would otherwise have worked, and cannot be the thing that resolves a second
// time either.
export function withScreeningLookup(args, target, block, lookup, skip) {
  const own = callerLookup(args);
  const resolve = typeof own === 'function' ? own : lookup;
  const screeningLookup = (hostname, options, callback) => {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (!opts || typeof opts !== 'object') opts = {};

    // What the resolver answered, in the shape the caller asked for.
    const handOver = (list) => {
      if (opts.all) return cb(null, list);
      const first = list[0];
      if (!first) return cb(new Error(`Patchstack: could not resolve ${hostname}`));

      return cb(null, first.address, first.family);
    };

    // Whether the resolver has answered yet. A throw after it answered belongs to whatever ran next —
    // including the caller's own callback — and translating that into a resolver error would call the
    // caller back a second time.
    let answered = false;
    try {
      resolve(hostname, { ...opts, all: true }, (err, addresses) => {
        answered = true;
        if (err) return cb(err);
        const list = Array.isArray(addresses) ? addresses : [];
        let blocked;
        try {
          blocked = screenResolved(list, target, block);
        } catch {
          // OURS is the only failure this falls open for, and it falls open onto the addresses already
          // in hand — never onto a second resolution, which is how an address the screen would have
          // refused could end up being the one that connects.
          skip('screen-failed', { host: hostname });

          return handOver(list);
        }
        if (blocked) {
          return cb(new Error(`Patchstack blocked an outbound request to a disallowed address: ${target.host} resolved to ${blocked}`));
        }

        return handOver(list);
      });
    } catch (err) {
      // The resolver threw instead of answering: its failure either way, so it is forwarded exactly as
      // a callback error is. Retrying it unscreened would ask a resolver that just refused to list
      // addresses for a single one, and connect to whatever it then said.
      if (answered) throw err;

      return cb(err);
    }
  };
  return injectLookupOption(args, screeningLookup);
}

/** The resolver this call already carried on its options, if it carried one. */
function callerLookup(args) {
  for (const arg of args) {
    if (arg && typeof arg === 'object' && !(arg instanceof URL) && typeof arg.lookup === 'function') return arg.lookup;
  }

  return undefined;
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
