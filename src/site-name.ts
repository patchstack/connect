/**
 * What the app this manifest describes is called.
 *
 * The project states this itself, on disk, before the app has a single visitor: in its HTML shell's
 * `<title>` and in its package manifest's `name`. `scan` reports it under the site's credential, and
 * Patchstack applies it only to a site that has no name yet; an owner can rename a site at any time.
 *
 * The values starter templates ship with are treated as "no name" rather than reported: an owner can
 * fix a wrong name, but a placeholder name hides that there is anything to fix.
 *
 * Like `site-url.ts`, this reads a value and sends it. It reads exactly two files, both of which the
 * project already serves or publishes: the root `index.html` (or `public/index.html`) and `package.json`.
 * No environment variable is read here; `PATCHSTACK_SITE_NAME` is handled with the rest of the config.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** The most Patchstack accepts for a name. */
const NAME_MAX_LENGTH = 191;

/**
 * `package.json` names that arrive with a starter template. A project still carrying one has not been
 * named; reporting it would label a real app "vite_react_shadcn_ts" in someone's dashboard.
 */
const TEMPLATE_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  // Lovable
  'vite_react_shadcn_ts',
  // Bolt
  'vite-react-typescript-starter',
  // Scaffolders and the names people accept from them
  'vite-project',
  'my-app',
  'my-project',
  'my-v0-project',
  'app',
  'frontend',
  'web',
  'client',
  'project',
  'template',
  'example',
  'react-app',
  'next-app',
  'nextjs',
  'starter',
  'test',
]);

/** `<title>` values that arrive with a starter template, compared case-insensitively. */
const TEMPLATE_TITLES: ReadonlySet<string> = new Set([
  'vite + react',
  'vite + react + ts',
  'vite + vue',
  'vite + vue + ts',
  'vite app',
  'react app',
  'create next app',
  'document',
  'untitled',
  'index',
  'home',
  'app',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Whitespace-collapsed, trimmed, capped to what the server stores; null when nothing is left. */
export function normaliseSiteName(value: string | undefined | null): string | null {
  const collapsed = (value ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;

  return collapsed.slice(0, NAME_MAX_LENGTH);
}

/**
 * Whether `code` is a Unicode scalar value, the only thing `String.fromCodePoint` accepts.
 *
 * Everything else in the numeric range an HTML author can write throws: past `0x10FFFF` there is no
 * character, and a lone surrogate is half of one. `<title>` is arbitrary text from a file this package
 * did not write, so a number it cannot represent has to be left as the text it was.
 */
function isScalarValue(code: number): boolean {
  return (
    Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
  );
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return isScalarValue(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return isScalarValue(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * The static `<title>` of an HTML shell, or null when there is none worth reporting. Read from the file,
 * so a title an app only sets from script is not seen here — that is the case the `name` config exists for.
 */
export function nameFromHtmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) return null;

  const name = normaliseSiteName(decodeEntities(match[1] ?? ''));
  if (name === null || TEMPLATE_TITLES.has(name.toLowerCase())) return null;

  return name;
}

/**
 * A `package.json` name made readable: the scope dropped, separators turned into spaces, each word
 * capitalised. `@acme/my-todo-app` reports as "My Todo App". Null for a template placeholder or anything
 * that is not a usable string.
 */
export function nameFromPackageName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const unscoped = raw.trim().replace(/^@[^/]+\//, '');
  if (unscoped === '' || TEMPLATE_PACKAGE_NAMES.has(unscoped.toLowerCase())) return null;

  const words = unscoped
    .split(/[-_.\s]+/)
    .filter((word) => word !== '')
    .map((word) => (word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1)));

  return normaliseSiteName(words.join(' '));
}

export interface DetectedSiteName {
  name: string;
  /** Which file it came from, so the CLI can print it. */
  source: 'index.html' | 'package.json';
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The name the project states for itself, or null when it states none. The HTML shell is preferred: it is
 * written for people, where a package name is written for a registry.
 */
export async function detectSiteName(cwd: string): Promise<DetectedSiteName | null> {
  for (const shell of ['index.html', path.join('public', 'index.html')]) {
    const html = await readIfPresent(path.join(cwd, shell));
    if (html === null) continue;

    const name = nameFromHtmlTitle(html);
    if (name !== null) return { name, source: 'index.html' };
  }

  const manifest = await readIfPresent(path.join(cwd, 'package.json'));
  if (manifest !== null) {
    try {
      const parsed: unknown = JSON.parse(manifest);
      const name = nameFromPackageName(
        typeof parsed === 'object' && parsed !== null ? (parsed as { name?: unknown }).name : undefined,
      );
      if (name !== null) return { name, source: 'package.json' };
    } catch {
      /* an unreadable package.json is the scan's problem to report, not the name's */
    }
  }

  return null;
}
