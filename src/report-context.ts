import type { EnvLike } from './stack.js';

/**
 * What prompted a manifest report, as the package manager names it.
 *
 * `install` and `build` come from `npm_lifecycle_event`, which npm, pnpm, Yarn and `bun run` set to the
 * running script's name. Anything else — a direct invocation, a `dev` script, a lifecycle name not listed
 * here — is `other`. Bun does not set the variable for install-time scripts, so a `postinstall` under
 * `bun install` reports `other`. The variable is inherited by child processes, so a command run from inside
 * a build's process tree reports `build`.
 */
export type ReportTrigger = 'install' | 'build' | 'other';

const INSTALL_EVENTS: ReadonlySet<string> = new Set(['preinstall', 'install', 'postinstall', 'prepare']);
const BUILD_EVENTS: ReadonlySet<string> = new Set(['prebuild', 'build', 'postbuild']);

export function reportTrigger(env: EnvLike = process.env): ReportTrigger {
  const event = env.npm_lifecycle_event;
  if (event === undefined) return 'other';
  if (INSTALL_EVENTS.has(event)) return 'install';
  if (BUILD_EVENTS.has(event)) return 'build';
  return 'other';
}

let runCommand: string | null = null;

/** The CLI command this process runs, named on each request so the site's activity log can show it. */
export function setRunCommand(command: string | null): void {
  runCommand = command;
}

/**
 * Headers every request from the CLI carries: the client, the command that sent it and what started
 * that command (an install, a build, or something else). Names only — never arguments or values.
 */
export function connectHeaders(env: EnvLike = process.env): Record<string, string> {
  return {
    'User-Agent': '@patchstack/connect',
    ...(runCommand !== null ? { 'X-Patchstack-Command': runCommand } : {}),
    'X-Patchstack-Trigger': reportTrigger(env),
  };
}

let runLogged = false;

/** Note that this run reached a request the site's activity log records, so it needs no run notice. */
export function markRunLogged(): void {
  runLogged = true;
}

export function runWasLogged(): boolean {
  return runLogged;
}
