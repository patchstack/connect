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

/** The coding agents Connect can recognise from the environment of the commands they run. */
export type CodingAgent = 'amp' | 'claude' | 'codex' | 'copilot' | 'cursor' | 'gemini' | 'opencode';

/**
 * The coding agent this CLI runs under, read from the variables agents set on the commands they start,
 * or null when none is recognised. Only the agent's name leaves the machine, never a variable's value.
 *
 * Order matters where agents set each other's markers: Amp also sets `CLAUDECODE`, so it is checked
 * before Claude Code. A child process inherits these variables, so this says an agent started the
 * process tree, not that nobody is watching.
 */
export function codingAgent(env: EnvLike = process.env): CodingAgent | null {
  const set = (name: string): boolean => {
    const value = env[name];
    return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
  };

  if (env.AGENT === 'amp' || set('AMP_CURRENT_THREAD_ID')) return 'amp';
  if (set('CODEX_THREAD_ID') || set('CODEX_CI') || set('CODEX_SANDBOX')) return 'codex';
  if (set('GEMINI_CLI')) return 'gemini';
  if (set('COPILOT_CLI') || set('COPILOT_AGENT_SESSION_ID')) return 'copilot';
  if (set('OPENCODE')) return 'opencode';
  if (set('CLAUDECODE') || set('CLAUDE_CODE')) return 'claude';
  if (set('CURSOR_AGENT')) return 'cursor';
  return null;
}

let runCommand: string | null = null;

/** The CLI command this process runs, named on each request so the site's activity log can show it. */
export function setRunCommand(command: string | null): void {
  runCommand = command;
}

/**
 * Headers every request from the CLI carries: the client, the command that sent it, what started that
 * command (an install, a build, or something else) and the coding agent running it, when one is
 * recognised. Names only — never arguments or values.
 */
export function connectHeaders(env: EnvLike = process.env): Record<string, string> {
  const agent = codingAgent(env);
  return {
    'User-Agent': '@patchstack/connect',
    ...(runCommand !== null ? { 'X-Patchstack-Command': runCommand } : {}),
    'X-Patchstack-Trigger': reportTrigger(env),
    ...(agent !== null ? { 'X-Patchstack-Agent': agent } : {}),
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
