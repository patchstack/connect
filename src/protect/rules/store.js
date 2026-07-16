// Rule cache as a TIERED store of a `{ bundle, etag }` envelope:
//   1. memory     — always present; last-known-good within the process. Survives refreshes and is
//                   the fallback when the disk isn't writable (read-only FS, sandbox).
//   2. durable    — filesystem (default, via `cacheDir`) OR a pluggable adapter (`ruleCache`, e.g.
//                   a KV store for filesystem-less runtimes). Survives process restarts.
// read: memory → durable → null.  write: memory + best-effort durable.  Everything is fail-open —
// a read/write error yields "no cache" rather than throwing.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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

function cachePath(dir) {
  return join(dir, 'patchstack-rules.json');
}

function cacheWrite(dir, env) {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(dir), JSON.stringify(env));
  } catch {
    /* cache is best-effort — the memory tier still holds last-known-good */
  }
}

function cacheRead(dir) {
  if (!dir) return null;
  try {
    return toEnvelope(JSON.parse(readFileSync(cachePath(dir), 'utf8')));
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
