import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { ROUTE_CALL_RE } from './routes.js';

// Cheap textual pre-filter so we only parse files that could contain an entry point. Derived from the
// same list as the AST recognizer (see ROUTE_REGISTER_NAMES).
export function hasEntrySignal(text: string): boolean {
  return (
    text.includes('createServerFn') ||
    /\bexport\s+(async\s+)?(function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(text) ||
    ROUTE_CALL_RE.test(text) ||
    text.includes("'use server'") || text.includes('"use server"') ||
    text.includes('Deno.serve') || /\bserve\s*\(/.test(text)
  );
}

export function detectFramework(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const d = { ...pkg.dependencies, ...pkg.devDependencies };
    if (d['@tanstack/react-start'] || d['@tanstack/start'] || d['@tanstack/solid-start']) return 'tanstack-start';
    if (d['next']) return 'next';
    if (d['@sveltejs/kit']) return 'sveltekit';
    if (d['@nestjs/core']) return 'nestjs';
    if (d['fastify']) return 'fastify';
    if (d['express']) return 'express';
    if (d['hono']) return 'hono';
  } catch { /* ignore */ }
  // A Deno/edge functions project may have no package.json at all.
  try {
    if (statSync(join(cwd, 'supabase', 'functions')).isDirectory()) return 'supabase-functions';
  } catch { /* not a supabase project */ }
  try {
    if (statSync(join(cwd, 'functions')).isDirectory()) return 'deno-functions';
  } catch { /* ignore */ }
  return 'unknown';
}

const isSourceFile = (name: string) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts');

// Directories that never hold app source, so walking the whole project stays cheap. (We walk the whole
// project rather than `src` only: server entrypoints, route dirs and platform function dirs commonly
// live at the root — `server.ts`, `app/`, `api/`, `routes/`, `functions/`, `netlify/`, `supabase/`.)
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'public', 'static', 'assets',
  '.git', '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.wrangler', '.turbo', '.cache',
  'vendor', 'tmp', 'temp', '__pycache__',
]);

export interface WalkStats {
  discovered: number;
  /**
   * Directories or links the walk could not traverse (permissions, a broken link, a vanished path) plus
   * subtrees deliberately left unvisited because a symlink escapes the project.
   *
   * These never become "files", so nothing downstream can notice them by counting: an unreadable
   * directory simply makes the tree look smaller. That is fine for the surface view and NOT fine for the
   * import inventory, whose whole value is that a package's absence means something — an unwalked subtree
   * can import anything. Any non-zero value here forfeits that claim.
   */
  unwalked: number;
}

/**
 * Walk the project for source files. Symlinks are followed ONLY while they stay inside the project
 * boundary (`boundary`, a realpath) — a link to an external repo would otherwise pull unrelated code
 * (and its paths) into the map. `followOutside` opts out of the boundary check. A realpath visited-set
 * makes link cycles safe.
 */
export function collectSources(
  dir: string,
  boundary: string,
  opts: { followOutside?: boolean },
  out: string[] = [],
  seen = new Set<string>(),
  stats: WalkStats = { discovered: 0, unwalked: 0 },
): string[] {
  let key: string;
  try { key = realpathSync(dir); } catch { stats.unwalked++; return out; }
  if (seen.has(key)) return out; // already walked via another path — not a gap
  if (!opts.followOutside && !isInside(key, boundary)) { stats.unwalked++; return out; }
  seen.add(key);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { stats.unwalked++; return out; }
  // Directory order is filesystem-dependent (APFS and ext4 disagree), and it decides the order of
  // endpoints and import sites in the document. Sorting makes the same tree produce the same bytes on
  // any machine — otherwise a rebuild in CI looks like a changed app and cuts a pointless new revision.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) collectSources(full, boundary, opts, out, seen, stats);
    else if (e.isSymbolicLink()) {
      let st, real;
      try { st = statSync(full); real = realpathSync(full); } catch { stats.unwalked++; continue; }
      // The link escapes the project: deliberate, but still a part of the tree we did not read, so it
      // counts against the inventory's completeness exactly like a failure would — but only when it
      // could have held source. A symlinked README outside the project must not forfeit the claim.
      if (!opts.followOutside && !isInside(real, boundary)) {
        if (st.isDirectory() || isSourceFile(e.name)) stats.unwalked++;
        continue;
      }
      if (st.isDirectory()) collectSources(full, boundary, opts, out, seen, stats);
      else if (st.isFile() && isSourceFile(e.name)) { out.push(full); stats.discovered++; }
    } else if (isSourceFile(e.name)) { out.push(full); stats.discovered++; }
  }
  return out;
}

export function isInside(candidate: string, boundary: string): boolean {
  if (candidate === boundary) return true;
  const rel = relative(boundary, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// --- deployment shapes ------------------------------------------------------
// What the PROJECT says about where it runs, as opposed to what its source says it does.
//
// The two answers come apart in the direction that matters. A project can hold a serverless function
// this extractor cannot parse — an unfamiliar handler signature, a runtime it does not model — and the
// endpoint walk then reports nothing, which is indistinguishable from an app that has no server at all.
// A consumer reading only `endpoints: []` would call that app static and tell its owner there is nothing
// to protect.
//
// So these are POSITIVE artifacts: a config file or a platform directory that exists. Each finding names
// the thing that proved it, because a classification a consumer cannot explain is one it should not act
// on — and the absence of every shape below is still not evidence of absence, only of "we found none".
const DEPLOYMENT_SHAPES: Array<{ shape: string; files?: string[]; dirs?: string[] }> = [
  // Config first: these are declarations by the project itself, and they survive a build output being
  // absent (a fresh clone has no `.vercel`/`.wrangler` directory).
  { shape: 'vercel', files: ['vercel.json'] },
  { shape: 'netlify', files: ['netlify.toml'] },
  // Wrangler names a Workers/Pages deployment. `.jsonc` and `.json` are both current spellings.
  { shape: 'cloudflare-workers', files: ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'] },
  // Pages advanced mode: a single worker entry at the project root takes over routing entirely.
  { shape: 'cloudflare-pages-advanced', files: ['_worker.js', '_worker.ts'] },
  { shape: 'netlify-functions', dirs: ['netlify/functions', 'netlify/edge-functions'] },
  { shape: 'supabase-functions', dirs: ['supabase/functions'] },
  // Ambiguous by nature and reported as one shape: a root `functions/` directory is Cloudflare Pages
  // Functions, Firebase functions, or a Deno layout depending on the platform, and nothing inside the
  // repository always distinguishes them. Naming it honestly is better than guessing a provider.
  { shape: 'root-functions-directory', dirs: ['functions'] },
  // The bare-root Vercel convention: `api/handler.ts` with no framework router. Next owns `pages/api`
  // and `app/api` instead, which the endpoint walk already recognizes, so this is reported as its own
  // shape rather than folded into `vercel`.
  { shape: 'root-api-directory', dirs: ['api'] },
];

export interface DeploymentShape {
  /** Which shape was recognized. */
  shape: string;
  /** The artifact that proved it, repo-relative — so a consumer can show its evidence. */
  source: string;
}

/**
 * Deployment artifacts present in the project, each with the file or directory that evidenced it.
 *
 * Cheap by construction: a handful of `statSync` calls at known paths, no walking. Never throws — an
 * unreadable project yields an empty list, which is a "found none" and must not be read as "has none".
 */
export function detectDeploymentShapes(cwd: string): DeploymentShape[] {
  const found: DeploymentShape[] = [];

  for (const candidate of DEPLOYMENT_SHAPES) {
    for (const file of candidate.files ?? []) {
      try {
        if (statSync(join(cwd, file)).isFile()) {
          found.push({ shape: candidate.shape, source: file });
          break; // one spelling is enough; the shape is the claim, not the filename
        }
      } catch { /* not this one */ }
    }

    for (const dir of candidate.dirs ?? []) {
      try {
        // A directory with no source file in it is scaffolding, not a deployment: an empty `api/`
        // would otherwise make every project that once considered serverless look like it ships it.
        if (statSync(join(cwd, dir)).isDirectory() && holdsSourceFile(join(cwd, dir))) {
          found.push({ shape: candidate.shape, source: dir });
          break;
        }
      } catch { /* not this one */ }
    }
  }

  return found;
}

/** Whether a directory holds at least one source file, one level down included. */
function holdsSourceFile(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && isSourceFile(entry.name)) return true;
      // One level deeper covers the per-function layout (`netlify/functions/hello/index.ts`) without
      // turning this into a walk.
      if (entry.isDirectory()) {
        try {
          for (const nested of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
            if (nested.isFile() && isSourceFile(nested.name)) return true;
          }
        } catch { /* unreadable subdirectory */ }
      }
    }
  } catch { /* unreadable */ }

  return false;
}
