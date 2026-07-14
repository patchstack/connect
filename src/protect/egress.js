// Egress guard MECHANISM only. Wraps the global `fetch` so the app's outbound requests
// can be screened; the block DECISION is delegated to a caller-supplied `shouldBlock`
// predicate (which the runtime builds from egress-phase rules — see defaults.js).
// No policy is hardcoded here: what counts as "internal"/disallowed lives in rules.
// WinterCG — works on Node 18+, Cloudflare Workers, Bun, Deno.

/**
 * @param {{ shouldBlock: (url:string, host:string|null, method:string)=>boolean,
 *           onBlock?: (info:{url:string,host:string|null,method:string})=>void }} opts
 * @returns {() => void} uninstall (restores the original fetch)
 */
export function installEgressGuard({ shouldBlock, onBlock } = {}) {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || original.__patchstackGuarded || typeof shouldBlock !== 'function') {
    return () => {};
  }

  const guarded = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    let host = null;
    try {
      host = new URL(url).hostname;
    } catch {
      host = null;
    }
    const method = (init && init.method) || (input && input.method) || 'GET';

    if (shouldBlock(url, host, method)) {
      onBlock?.({ url, host, method });
      throw new Error(`Patchstack blocked an outbound request to a disallowed address: ${host ?? url}`);
    }
    return original(input, init);
  };

  guarded.__patchstackGuarded = true;
  globalThis.fetch = guarded;

  return () => {
    if (globalThis.fetch === guarded) {
      globalThis.fetch = original;
    }
  };
}
