import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { ROUTE_CALL_RE } from './routes.js';
import type { DeploymentEvidence, DeploymentShape } from './types.js';

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
//
// Findings are not equally strong, and the difference is carried in the data rather than left for a
// consumer to rediscover:
//
//   runtime-entry      code that SERVES — a worker entry, or a provider function directory with source
//   deployment-config  the project deploys to a platform, which says nothing about anything serving
//   layout             an ordinary application folder that MIGHT be functions (`api/`, `functions/`)
//
// The `deployment-config` line is the one worth being careful about: a static site on Netlify has a
// `netlify.toml`, a static Vercel project has a `vercel.json`, and a Pages project deploying only assets
// has a `wrangler.toml`. Reading any of those as a server runtime would classify a large share of purely
// static apps as having one — so they establish "deploys somewhere", nothing more.
//
// `layout` exists because `api/client.ts` is a perfectly normal front-end folder and `api/handler.ts` is a
// Vercel function, and from the outside they are the same directory name.
//
// A classifier may use `deployment-config` and `layout` to stay UNDECIDED; neither may conclude a runtime.
//
// `DeploymentEvidence` and `DeploymentShape` are imported from `types.ts` rather than restated: they are the
// document's contract, and two structural copies of a vocabulary is how the two drift apart later.
const DEPLOYMENT_SHAPES: Array<{ shape: string; evidence: DeploymentEvidence; files?: string[]; dirs?: string[] }> = [
  // Config first: these are declarations by the project itself, and they survive a build output being
  // absent (a fresh clone has no `.vercel`/`.wrangler` directory).
  { shape: 'vercel', evidence: 'deployment-config', files: ['vercel.json'] },
  { shape: 'netlify', evidence: 'deployment-config', files: ['netlify.toml'] },
  // Wrangler names a Workers/Pages deployment. `.jsonc` and `.json` are both current spellings.
  { shape: 'cloudflare-workers', evidence: 'deployment-config', files: ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'] },
  // Pages advanced mode: a single worker entry at the project root takes over routing entirely. Unlike a
  // wrangler config, this file IS the server — it is a runtime entry, not a deployment declaration.
  { shape: 'cloudflare-pages-advanced', evidence: 'runtime-entry', files: ['_worker.js', '_worker.ts'] },
  { shape: 'netlify-functions', evidence: 'runtime-entry', dirs: ['netlify/functions', 'netlify/edge-functions'] },
  { shape: 'supabase-functions', evidence: 'runtime-entry', dirs: ['supabase/functions'] },
  // Ambiguous by nature and reported as one shape: a root `functions/` directory is Cloudflare Pages
  // Functions, Firebase functions, or a Deno layout depending on the platform, and nothing inside the
  // repository always distinguishes them. Naming it honestly is better than guessing a provider.
  { shape: 'root-functions-directory', evidence: 'layout', dirs: ['functions'] },
  // The bare-root Vercel convention: `api/handler.ts` with no framework router. Next owns `pages/api`
  // and `app/api` instead, which the endpoint walk already recognizes, so this is reported as its own
  // shape rather than folded into `vercel`.
  { shape: 'root-api-directory', evidence: 'layout', dirs: ['api'] },
];

export interface DeploymentScanOptions {
  /** Project boundary (a real path). Candidates resolving outside it are refused. */
  boundary?: string;
  /** Follow artifacts that resolve outside the project (off by default, like the source walk). */
  followOutside?: boolean;
}

/**
 * Deployment artifacts present in the project, each with the file or directory that evidenced it.
 *
 * Cheap by construction: a handful of `statSync` calls at known paths, no walking. Never throws — an
 * unreadable project yields an empty list, which is a "found none" and must not be read as "has none".
 *
 * Symlinks are resolved and refused when they leave the project, the same rule the source walk applies. A
 * symlinked `api/` pointing at a sibling workspace would otherwise become THIS project's deployment
 * evidence — the analysis would describe a runtime that belongs to different code.
 */
export function detectDeploymentShapes(cwd: string, opts: DeploymentScanOptions = {}): DeploymentShape[] {
  let boundary = opts.boundary ?? cwd;
  try { boundary = realpathSync(boundary); } catch { /* use as given */ }

  const inProject = (path: string): boolean => {
    if (opts.followOutside) return true;
    try {
      return isInside(realpathSync(path), boundary);
    } catch {
      return false; // unresolvable is not in-project, and not evidence
    }
  };

  const found: DeploymentShape[] = [];

  for (const candidate of DEPLOYMENT_SHAPES) {
    for (const file of candidate.files ?? []) {
      const full = join(cwd, file);
      try {
        if (statSync(full).isFile() && inProject(full)) {
          found.push({ shape: candidate.shape, source: file, evidence: candidate.evidence });
          break; // one spelling is enough; the shape is the claim, not the filename
        }
      } catch { /* not this one */ }
    }

    for (const dir of candidate.dirs ?? []) {
      const full = join(cwd, dir);
      try {
        // A directory with no source file in it is scaffolding, not a deployment: an empty `api/`
        // would otherwise make every project that once considered serverless look like it ships it.
        // `statSync` FOLLOWS symlinks, which is what makes the boundary check here load-bearing: a
        // linked `api/` reports as a directory and would otherwise be this project's evidence.
        if (statSync(full).isDirectory() && inProject(full) && holdsSourceFile(full)) {
          found.push({ shape: candidate.shape, source: dir, evidence: candidate.evidence });
          break;
        }
      } catch { /* not this one */ }
    }
  }

  return found;
}

/**
 * Whether a directory holds at least one source file, one level down included.
 *
 * No boundary check here, and deliberately not: `readdirSync(withFileTypes)` classifies a symlink as
 * neither a file nor a directory, so a linked entry can never satisfy either branch and cannot smuggle
 * outside code into this test. Every entry that reaches a `return true` is a real file at a real path
 * under `dir`, which the caller has already confirmed is in-project.
 *
 * (A first version did check the boundary at each hop. It was unreachable — verified by removing the
 * top-level refusal, which failed the escaping-directory tests while the nested one stayed green.)
 *
 * The accepted cost is a legitimate in-project symlink inside a provider directory not counting as
 * source. That errs toward reporting no shape, which the map already states is not evidence of absence.
 */
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
