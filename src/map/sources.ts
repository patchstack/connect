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
