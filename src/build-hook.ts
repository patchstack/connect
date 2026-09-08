import { SECRET_CONFIG_FILENAME } from './config.js';
import type { Config, PatchstackError } from './types.js';

/**
 * Lifecycle names under which `scan` is a hook on somebody else's install or build: the `postinstall`,
 * `prebuild` and Bun `build` chain that `setup` wires, and the neighbours a project wires by hand.
 */
const INSTALL_AND_BUILD_EVENTS: ReadonlySet<string> = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prebuild',
  'build',
  'postbuild',
]);

/**
 * Whether this process is a lifecycle hook on an install or build.
 *
 * In that position the report is the connector's concern and the build is not: a manifest Patchstack
 * cannot accept is said in full, and the build goes on. Run directly, the same failure exits non-zero.
 *
 * npm, pnpm, Yarn and `bun run` name the running script in `npm_lifecycle_event`; a direct invocation
 * carries a different name (`npx`, or the bin's own name under Bun) or none at all. Bun does not set it
 * for install-time scripts, so a `postinstall` hook under `bun install` is not recognised and fails
 * closed. The variable is inherited by child processes, so a direct run from inside a build's process
 * tree counts as a hook too — the error is still printed, so what that costs is an exit code, not silence.
 */
export function isInstallOrBuildHook(env: NodeJS.ProcessEnv = process.env): boolean {
  const event = env.npm_lifecycle_event;

  return typeof event === 'string' && INSTALL_AND_BUILD_EVENTS.has(event);
}

/**
 * What a hooked `scan` prints when it could not deliver its report.
 *
 * The error's own message names the remedy for a developer machine. A build environment needs a different
 * one: it never has the credential file, `login` refuses to run there, and the only fix is the platform's
 * environment. Said for the credential cases only; a network or server failure has nothing to set.
 *
 * When no credential was found, the line names every source that was checked and where. Somebody who can
 * see the file on their own machine reads "none is configured" as "the file was not read", and the log is
 * the only place that can settle it.
 */
export function undeliveredReportLines(err: PatchstackError, config: Config, cwd: string): string[] {
  const lines = [`patchstack: manifest not reported — ${err.message}`];

  if (err.code === 'UNAUTHORIZED') {
    const hasCredential = typeof config.pulseAuth === 'string' && config.pulseAuth.length > 0;
    if (hasCredential) {
      lines.push(
        'patchstack: the credential this environment holds was rejected. If `login` rotated it, set the new value as PATCHSTACK_API_KEY here.',
      );
    } else {
      lines.push(
        `patchstack: PATCHSTACK_API_KEY is not set, and neither ${SECRET_CONFIG_FILENAME} nor .patchstackrc.json in ${cwd} holds a credential.`,
        `patchstack: ${SECRET_CONFIG_FILENAME} is git-ignored, so a clean checkout never has it. Set PATCHSTACK_API_KEY in the platform's environment so builds can report.`,
      );
    }
  }

  lines.push(
    'patchstack: continuing the build. Patchstack keeps the last manifest it accepted for this site until a scan that can report.',
  );

  return lines;
}
