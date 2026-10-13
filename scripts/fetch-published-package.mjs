import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * A version npm has just published can take minutes to become visible from the public registry; until it
 * does, `npm pack` answers ETARGET ("no matching version"). The attempts below wait up to about seven and
 * a half minutes in all, which is what a release needs, and still give up on a registry that is down.
 */
export const MAX_ATTEMPTS = 10;
export const waitBefore = (attempt) => Math.min(attempt * 15000, 60000);

export async function fetchPublishedPackage(version, {
  run = spawnSync,
  wait = delay,
  makeDirectory = () => mkdtempSync(join(tmpdir(), 'published-package-')),
  exists = existsSync,
  log = console.error,
} = {}) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    throw new Error('An explicit release version is required.');
  }
  // Fetch outside the checkout, with a fresh cache and an explicit public registry. Local project
  // configuration and cached registry misses must not decide whether a new release can be verified.
  const directory = makeDirectory();
  const filename = `patchstack-connect-${version}.tgz`;
  let packed = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // A cache of its own per attempt, so a "no matching version" answer one attempt received is never
    // what the next attempt reads back.
    const result = run('npm', [
      'pack', `@patchstack/connect@${version}`, '--ignore-scripts', '--json',
      '--registry=https://registry.npmjs.org', '--prefer-online',
      '--fetch-retries=0', '--fetch-timeout=30000',
      '--cache', join(directory, `cache-${attempt}`), '--pack-destination', directory,
    ], { cwd: directory, encoding: 'utf8', timeout: 60000 });
    if (result.status === 0) {
      const metadata = JSON.parse(result.stdout);
      if (metadata.length !== 1 || metadata[0].name !== '@patchstack/connect' ||
          metadata[0].version !== version || metadata[0].filename !== filename ||
          !exists(join(directory, filename))) {
        throw new Error('The downloaded package does not match the requested release.');
      }
      packed = true;
      break;
    }
    const diagnostics = String(result.stderr || result.stdout || result.error?.message || 'npm returned no diagnostics.').trim();
    log(`Package fetch attempt ${attempt}/${MAX_ATTEMPTS} failed (exit ${result.status ?? result.signal ?? 'unknown'}).`);
    if (diagnostics.includes('ETARGET')) log(`npm does not show ${version} yet; a new release can take a few minutes to appear.`);
    log(diagnostics);
    if (attempt < MAX_ATTEMPTS) await wait(waitBefore(attempt));
  }
  if (!packed) throw new Error(`Could not fetch @patchstack/connect@${version}; the published package remains unverified.`);
  const extracted = run('tar', ['-xzf', join(directory, filename), '-C', directory], {
    encoding: 'utf8', timeout: 30000,
  });
  if (extracted.status !== 0) throw new Error(`Could not unpack the published package: ${extracted.stderr || extracted.error?.message}`);
  const engine = join(directory, 'package', 'dist', 'protect.js');
  if (!exists(engine)) throw new Error('The published package has no dist/protect.js.');
  return engine;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const engine = await fetchPublishedPackage(process.argv[2]);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `engine=${engine}\n`);
    console.log(`Downloaded engine: ${engine}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
