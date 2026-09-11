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
import { notify } from './notify.js';

export async function installEgressGuard({ shouldBlock, onBlock, onSkip, dnsScreen = true, lookup, allowHosts } = {}) {
  const restores = [];
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

    // Screen one outbound URL: hostname/allowlist/literal-IP check, then a DNS-resolution check for
    // real hostnames. Throws if the destination is disallowed.
    const screenUrl = async (u, method) => {
      let host = null;
      try {
        host = new URL(u).hostname;
      } catch {
        host = null;
      }
      if (block(u, host, method) || (await resolvesToDisallowed(u, host, method))) {
        throw new Error(`Patchstack blocked an outbound request to a disallowed address: ${host ?? u}`);
      }
    };

    const guarded = async (input, init) => {
      let cur;
      try {
        cur = new Request(input, { ...(init || {}), redirect: 'manual' });
      } catch {
        return originalFetch(input, init); // odd input we can't normalize — fail open, don't break the caller
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
    restores.push(() => {
      if (globalThis.fetch === guarded) globalThis.fetch = originalFetch;
    });
  }

  // node:http / node:https — best-effort; absent on Workers/Deno-without-node (import throws).
  for (const moduleName of ['node:http', 'node:https']) {
    try {
      const mod = await import(moduleName);
      const restore = patchHttpModule(mod.default ?? mod, block, screen, skip);
      if (restore) restores.push(restore);
    } catch {
      /* module not available on this runtime — skip */
    }
  }

  // WebSocket egress is intentionally NOT screened. The WebSocket constructor is synchronous, so
  // the only check possible inline is a textual hostname match — which can't offer the
  // DNS-resolution guarantee the fetch and node:http/https paths give (a name that resolves to an
  // internal address would pass). A connection-pinning dispatcher could close that, but the
  // server-side, attacker-controlled-WebSocket sink is rare, and a partial hostname-only check
  // over-promises the control. Outbound SSRF screening covers fetch + node:http/https.

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
function patchHttpModule(http, block, screen, skip) {
  if (!http || typeof http.request !== 'function' || http.__patchstackGuarded) return null;
  const originalRequest = http.request;
  const originalGet = http.get;

  const wrap = (original) =>
    function (...args) {
      const target = extractHttpTarget(args);
      if (target && block(target.url, target.host, target.method)) {
        throw new Error(`Patchstack blocked an outbound request to a disallowed address: ${target.host ?? target.url}`);
      }
      // DNS screen: only for real hostnames (a literal IP was already covered by the check above),
      // and skip an explicitly allowlisted host (the operator trusts it — don't second-guess its DNS).
      if (target && screen && target.host && screen.isIP(target.host) === 0 && !screen.isExempt(target.host)) {
        try {
          args = withScreeningLookup(args, target, block, screen.lookup, skip);
        } catch {
          // The call goes on with the arguments it came with. Nothing is counted as a fail-open bypass:
          // the only thing here that can throw is reading the caller's options, and Node copies that
          // object itself before doing anything — so options this cannot read are options Node refuses
          // too, and no traffic was served unscreened to report.
        }
      }
      return original.apply(this, args);
    };

  const guardedRequest = wrap(originalRequest);
  http.request = guardedRequest;
  let guardedGet;
  if (typeof originalGet === 'function') {
    guardedGet = wrap(originalGet);
    http.get = guardedGet;
  }
  http.__patchstackGuarded = true;

  return () => {
    // Only restore if our wrapper is still installed — don't clobber a wrapper another library
    // (an APM agent, etc.) layered on top of us after install.
    if (http.request === guardedRequest) http.request = originalRequest;
    if (guardedGet && http.get === guardedGet) http.get = originalGet;
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
      // Node defaults an absent host to localhost — reflect that so the block/screen see a real target.
      const host = normalizeHost(first.hostname || first.host) || 'localhost';
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
