// Shared helpers for the `patchstack-connect protect` scaffolder (adapters + orchestrator).

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const read = (p: string): string => readFileSync(p, 'utf8');
export const log = (msg: string): void => console.log(`patchstack protect: ${msg}`);

/** True when `name` is in the project's dependencies or devDependencies. */
export function hasDependency(cwd: string, name: string): boolean {
  try {
    const pkg = JSON.parse(read(join(cwd, 'package.json')));
    return Boolean({ ...pkg.dependencies, ...pkg.devDependencies }[name]);
  } catch {
    return false;
  }
}

/**
 * Is a credential resolvable from this machine?
 *
 * Only used to word a note: it says nothing about the deployment, which is where the credential has to be,
 * and the note is printed either way. Reads the files directly rather than going through config resolution
 * so that verification stays synchronous and never throws.
 */
export function hasResolvableCredential(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  // The environment is a parameter so that a caller judging one environment judges it consistently: a
  // check that read the injected environment for one fact and `process.env` for another would be
  // answering about two different machines in the same sentence.
  if ((env.PATCHSTACK_API_KEY ?? '') !== '' || (env.PATCHSTACK_PULSE_AUTH ?? '') !== '') {
    return true;
  }

  for (const file of ['.patchstackrc.local.json', '.patchstackrc.json']) {
    try {
      const parsed = JSON.parse(read(join(cwd, file))) as { apiKey?: unknown; pulseAuth?: unknown };
      if (typeof parsed.apiKey === 'string' && parsed.apiKey !== '') return true;
      if (typeof parsed.pulseAuth === 'string' && parsed.pulseAuth !== '') return true;
    } catch {
      // Absent or unreadable — the next candidate, then the note's other wording.
    }
  }

  return false;
}

const SITE_UUID_PLACEHOLDER = '__PATCHSTACK_SITE_UUID__';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this a usable site identity?
 *
 * Exported so the scaffolder's idea of a usable identity and the one `protect --check` reports on are
 * the same idea: a value the scaffolder will not bake is not an enrolment worth reporting.
 */
export function isSiteUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Bake the site UUID written by `scan` into a managed runtime-guard template.
 *
 * The UUID is public project configuration (the disclosure widget exposes the
 * same value). Keeping the environment-variable fallback in the template lets
 * unscanned projects remain inert and lets deployments override it explicitly.
 */
export function bakeSiteUuid(cwd: string, guardRelPath: string): boolean {
  const rc = join(cwd, '.patchstackrc.json');
  if (!existsSync(rc)) {
    log('no .patchstackrc.json — guard uses PATCHSTACK_SITE_UUID env or the bundled fallback');
    return false;
  }

  let uuid: unknown;
  try {
    uuid = JSON.parse(read(rc)).siteUuid;
  } catch {
    log('.patchstackrc.json unreadable — skipping site-UUID bake');
    return false;
  }

  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
    log('.patchstackrc.json siteUuid missing or malformed — guard uses PATCHSTACK_SITE_UUID env or the bundled fallback');
    return false;
  }

  const guardPath = join(cwd, guardRelPath);
  if (!existsSync(guardPath)) return false;
  const source = read(guardPath);
  if (!source.includes(SITE_UUID_PLACEHOLDER)) {
    log(`${guardRelPath} site UUID already baked`);
    return false;
  }

  writeFileSync(guardPath, source.replace(SITE_UUID_PLACEHOLDER, uuid));
  log(`baked site UUID into ${guardRelPath} — live rules from the Patchstack API`);
  return true;
}

// Guard templates ship next to the built CLI (dist/protect/templates). Resolve for the built
// layout (this code is bundled into dist/cli.js at the dist root → protect/templates) and the
// source layout (this file lives in src/protect/install/ → ../templates).
const HERE = dirname(fileURLToPath(import.meta.url));
export function templatesDir(): string {
  const builtLayout = join(HERE, 'protect', 'templates'); // built: dist/cli.js → dist/protect/templates
  const candidates = [
    builtLayout,
    join(HERE, '..', 'templates'), // source: src/protect/install/ → src/protect/templates
    join(HERE, 'templates'),
  ];
  return candidates.find((p) => existsSync(p)) ?? builtLayout;
}
