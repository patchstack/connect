// Rule cache as a TIERED store of a `{ bundle, etag }` envelope:
//   1. memory     — always present; last-known-good within the process. Survives refreshes and is
//                   the fallback when the disk isn't writable (read-only FS, sandbox).
//   2. durable    — filesystem (default, via `cacheDir`) OR a pluggable adapter (`ruleCache`, e.g.
//                   a KV store for filesystem-less runtimes). Survives process restarts.
// read: memory → durable → null.  write: memory + best-effort durable.  Everything is fail-open —
// a read/write error yields "no cache" rather than throwing.
//
// Node's fs/path are loaded LAZILY (dynamic import), never as a static top-level import: this module
// is part of the WinterCG/edge-safe graph (Next edge middleware, Workers, Deno, Supabase Functions),
// where a static `node:fs` import fails to resolve at build/load time and would take the whole guard
// down. On those runtimes the disk tier simply reports "no cache" and the memory tier (or a pluggable
// `ruleCache` adapter) carries last-known-good.

let fsMod; // memoized { readFileSync, writeFileSync, mkdirSync, join } | null (unavailable)
async function loadFs() {
  if (fsMod !== undefined) return fsMod;
  try {
    const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
    fsMod = {
      readFileSync: fs.readFileSync,
      writeFileSync: fs.writeFileSync,
      mkdirSync: fs.mkdirSync,
      join: path.join,
    };
  } catch {
    fsMod = null; // no filesystem here (edge runtime) — memory/adapter tiers still work
  }
  return fsMod;
}

export function makeStore(options = {}) {
  let mem = null;
  const durable = durableTier(options);
  return {
    async read() {
      if (mem) return mem;
      const env = await durable.read();
      if (env) mem = env;
      return env;
    },
    async write(env) {
      if (env) mem = env;
      await durable.write(env);
    },
  };
}

// The durable tier: a caller-supplied adapter wins; otherwise a disk cache under `cacheDir`; if
// neither is configured, a no-op (memory-only — fine for a long-lived process).
function durableTier(options) {
  const adapter = options.ruleCache;
  if (adapter && typeof adapter.read === 'function' && typeof adapter.write === 'function') {
    return {
      read: async () => {
        try {
          return toEnvelope(await adapter.read());
        } catch {
          return null;
        }
      },
      write: async (env) => {
        try {
          await adapter.write(env);
        } catch {
          /* best-effort */
        }
      },
    };
  }
  const dir = options.cacheDir;
  return {
    read: async () => cacheRead(dir),
    write: async (env) => cacheWrite(dir, env),
  };
}

async function cacheWrite(dir, env) {
  if (!dir) return;
  const fs = await loadFs();
  if (!fs) return; // filesystem-less runtime — memory tier only
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fs.join(dir, 'patchstack-rules.json'), JSON.stringify(env));
  } catch {
    /* cache is best-effort — the memory tier still holds last-known-good */
  }
}

async function cacheRead(dir) {
  if (!dir) return null;
  const fs = await loadFs();
  if (!fs) return null;
  try {
    return toEnvelope(JSON.parse(fs.readFileSync(fs.join(dir, 'patchstack-rules.json'), 'utf8')));
  } catch {
    return null;
  }
}

// Accept the current { bundle, etag } envelope and a legacy bare bundle (pre-envelope cache files).
export function toEnvelope(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.bundle && typeof value.bundle === 'object') {
    return { bundle: value.bundle, etag: value.etag ?? null };
  }
  if (Array.isArray(value.firewall) || Array.isArray(value.whitelists)) {
    return { bundle: value, etag: null }; // legacy bare-bundle cache file
  }
  return null;
}
