import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Marks a production build so the embeddable Patchstack widget can tell it's
 * running on the live site (and therefore hide the claim / "connect this site"
 * flow — claiming is meant to happen in the builder's edit mode only).
 *
 * It injects a tiny inline script into the BUILT HTML:
 *
 *     <script>window.__PATCHSTACK_PROD__=true</script>
 *
 * Crucially this touches the build OUTPUT only, never the source — so dev/edit
 * previews (which don't run this step) carry no flag and still show the claim
 * flow, while `npm run build` output does.
 */

const FLAG_MARKER = '__PATCHSTACK_PROD__';
const SNIPPET = '<script>window.__PATCHSTACK_PROD__=true;/*patchstack:production*/</script>';

/** Build-output directories checked, in order, when none is given. */
const DEFAULT_DIRS = ['dist', 'build', 'out', '.output/public'];

export interface MarkBuildResult {
  /** The build dir that was used, or null if none was found. */
  dir: string | null;
  /** HTML files that had the flag injected. */
  patched: string[];
  /** HTML files already carrying the flag (left untouched). */
  skipped: string[];
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveBuildDir(cwd: string, override?: string): Promise<string | null> {
  if (override !== undefined && override.length > 0) {
    const dir = path.resolve(cwd, override);
    return (await pathExists(dir)) ? dir : null;
  }
  for (const candidate of DEFAULT_DIRS) {
    const dir = path.resolve(cwd, candidate);
    if (await pathExists(dir)) {
      return dir;
    }
  }
  return null;
}

async function findHtmlFiles(dir: string, depth = 3): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) {
        found.push(...(await findHtmlFiles(full, depth - 1)));
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
      found.push(full);
    }
  }
  return found;
}

/** Inject the flag at the top of <head> (or <body>), or null if already present. */
function injectFlag(html: string): string | null {
  if (html.includes(FLAG_MARKER)) {
    return null;
  }
  const headOpen = /<head[^>]*>/i;
  if (headOpen.test(html)) {
    return html.replace(headOpen, (match) => `${match}${SNIPPET}`);
  }
  const bodyOpen = /<body[^>]*>/i;
  if (bodyOpen.test(html)) {
    return html.replace(bodyOpen, (match) => `${match}${SNIPPET}`);
  }
  return `${SNIPPET}${html}`;
}

/**
 * Inject the production flag into every HTML file of the build output.
 * Returns a summary; never throws for "no output" / "no HTML" (the caller
 * treats those as a no-op so the build is never blocked).
 */
export async function markProductionBuild(
  cwd: string,
  override?: string,
): Promise<MarkBuildResult> {
  const dir = await resolveBuildDir(cwd, override);
  if (dir === null) {
    return { dir: null, patched: [], skipped: [] };
  }

  const files = await findHtmlFiles(dir);
  const patched: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const html = await fs.readFile(file, 'utf8');
    const next = injectFlag(html);
    if (next === null) {
      skipped.push(file);
      continue;
    }
    await fs.writeFile(file, next, 'utf8');
    patched.push(file);
  }

  return { dir, patched, skipped };
}
