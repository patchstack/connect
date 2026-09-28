// Rule cache as a TIERED store of a `{ bundle, etag, buildId, matchedBuildId, source }` envelope:
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

import { canonicalBuildId } from '../../build-id.js';

let fsMod; // memoized Node filesystem operations, or null when unavailable
async function loadFs() {
  if (fsMod !== undefined) return fsMod;
  try {
    const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
    fsMod = {
      chmodSync: fs.chmodSync,
      closeSync: fs.closeSync,
      constants: fs.constants,
      fstatSync: fs.fstatSync,
      fsyncSync: fs.fsyncSync,
      lstatSync: fs.lstatSync,
      openSync: fs.openSync,
      readFileSync: fs.readFileSync,
      mkdirSync: fs.mkdirSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
      writeFileSync: fs.writeFileSync,
      join: path.join,
    };
  } catch {
    fsMod = null; // no filesystem here (edge runtime) — memory/adapter tiers still work
  }
  return fsMod;
}

/**
 * The rules source a guard is configured for, as a string an envelope can be compared against.
 *
 * A cache is only ever one source's last-known-good. The same `cacheDir` can be shared by a site and a
 * re-provisioned site, by the site-UUID and token paths, or by two endpoints, and an envelope read for
 * the wrong one would be enforced, attributed and revalidated as if it were this guard's own policy. So
 * every envelope carries the source it was fetched for, and an envelope for any other source — or for
 * none, as every cache written before this existed — reads as no cache.
 *
 * The token is never stored: its SHA-256 identifies it. Null when there is no live source, or when this
 * runtime cannot compute a digest, and a null identity reads nothing.
 */
export async function sourceIdentity(options = {}) {
  if (typeof options.siteUuid === 'string' && options.siteUuid.trim() !== '') {
    const endpoint = typeof options.pulseRulesUrl === 'string' ? options.pulseRulesUrl : '';

    return `site:${options.siteUuid.trim().toLowerCase()}@${endpoint}`;
  }
  if (typeof options.token === 'string' && options.token !== '') {
    const digest = await sha256Hex(options.token);
    if (digest === null) return null;
    const endpoint = typeof options.baseUrl === 'string' ? options.baseUrl : '';

    return `token:${digest}@${endpoint}`;
  }

  return null;
}

async function sha256Hex(text) {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof TextEncoder === 'undefined') return null;
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));

    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export function makeStore(options = {}) {
  let mem = null;
  const durable = durableTier(options);
  let identity;
  const identityOf = () => (identity ??= sourceIdentity(options));

  return {
    async read() {
      if (mem) return mem;
      const source = await identityOf();
      if (source === null) return null;
      const env = await durable.read();
      if (!env || env.source !== source) return null;
      mem = env;

      return env;
    },
    async write(env) {
      if (!env) return;
      const stamped = { ...env, source: await identityOf() };
      mem = stamped;
      await durable.write(stamped);
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
  const target = fs.join(dir, 'patchstack-rules.json');
  const temporary = fs.join(dir, `.patchstack-rules-${randomSuffix()}.tmp`);
  let descriptor = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const directory = fs.lstatSync(dir);
    if (directory.isSymbolicLink() || !directory.isDirectory()) return;

    let mode;
    try {
      const current = fs.lstatSync(target);
      if (current.isSymbolicLink() || !current.isFile()) return;
      mode = current.mode & 0o7777;
    } catch (error) {
      if (error?.code !== 'ENOENT') return;
    }

    descriptor = fs.openSync(temporary, 'wx', mode ?? 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(env), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (mode !== undefined) fs.chmodSync(temporary, mode);
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (typeof process === 'undefined' || process.platform !== 'win32'
        || (error?.code !== 'EEXIST' && error?.code !== 'EPERM')) throw error;
      try {
        fs.unlinkSync(target);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
      fs.renameSync(temporary, target);
    }
  } catch {
    /* cache is best-effort — the memory tier still holds last-known-good */
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* best-effort */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* already renamed or never created */ }
  }
}

async function cacheRead(dir) {
  if (!dir) return null;
  const fs = await loadFs();
  if (!fs) return null;
  const target = fs.join(dir, 'patchstack-rules.json');
  let descriptor = null;
  try {
    const entry = fs.lstatSync(target);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 16 * 1024 * 1024) return null;
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    descriptor = fs.openSync(target, flags);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > 16 * 1024 * 1024) return null;
    return toEnvelope(JSON.parse(fs.readFileSync(descriptor, 'utf8')));
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* best-effort */ }
    }
  }
}

function randomSuffix() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    // The exclusive create below is the collision backstop.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Accept the current { bundle, etag, buildId, matchedBuildId } envelope, the older { bundle, etag }
// one, and a legacy bare bundle (pre-envelope cache files).
//
// Two identity fields, and the difference between them is the whole point.
//
// `buildId` is which map identity was PRESENTED when this bundle was fetched. It scopes the conditional
// request: revalidating against another map's ETag would return 304 and hand that map's
// bundle back as current.
//
// `matchedBuildId` is the map the PLATFORM confirmed these coordinates belong to. Only that
// licenses a build-scoped rule to enforce. It is null unless a server said so explicitly, so an older
// platform, an unrecognised verdict and a cache written before any of this existed all read the same:
// no confirmation, and scoped rules detect only.
export function toEnvelope(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.bundle && typeof value.bundle === 'object') {
    const buildId = canonicalBuildId(value.buildId);
    const matched = canonicalBuildId(value.matchedBuildId);

    return {
      bundle: value.bundle,
      etag: value.etag ?? null,
      buildId,
      // A confirmation belongs to the presentation stored beside it. A crossed or partially written
      // envelope confirms nothing, even when one of its fields happens to name the current map.
      matchedBuildId: buildId !== null && matched === buildId ? matched : null,
      source: typeof value.source === 'string' ? value.source : null,
    };
  }
  if (Array.isArray(value.firewall) || Array.isArray(value.whitelists)) {
    // legacy cache file: no source identity, so it matches no configured source
    return { bundle: value, etag: null, buildId: null, matchedBuildId: null, source: null };
  }
  return null;
}
