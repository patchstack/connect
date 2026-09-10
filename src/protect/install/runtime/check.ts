// `protect --check --runtime`: the opt-in half of the wiring check.
//
// The default `--check` reads the app's source and can say the guard is wired. It cannot say a request
// ever reached it. This adds that one fact, and it is opt-in because the only way to establish it is to
// start the application — which the default check, `setup` and `guide` must never do.
//
// Three answers, never two, and each one keeps its own exit code. `proven` means a request traversed the
// scaffolded seam; `not-traversed` means a listener answered and the seam did not; `unavailable` means
// this could not be established from here, which is neither a pass nor a failure. `unavailable` is the
// answer whenever the run cannot speak for the whole app — an entry it may not launch, a listener it
// cannot probe, an attempted process launch, a worker whose listeners cannot report back, or anything
// the app opened after discovery closed.

import { relative } from 'node:path';

import { resolveEntry } from './entry.js';
import { probeRuntimeTraversal, type ListenerResult } from './probe.js';

export interface RuntimeCheckReport {
  outcome: 'proven' | 'not-traversed' | 'unavailable';
  /** Why the run was `unavailable`. */
  reason?: string;
  /** The entry that was launched, repo-relative, and where it came from. Absent if nothing was. */
  entry?: { file: string; from: string };
  listeners: ListenerResult[];
  /** Bounded child output, kept for the failure lines. */
  output: string;
}

export interface RuntimeCheckOptions {
  timeoutMs?: number;
  settleMs?: number;
  platform?: string;
}

export async function runRuntimeCheck(cwd: string, options: RuntimeCheckOptions = {}): Promise<RuntimeCheckReport> {
  const entry = resolveEntry(cwd);
  if (entry.kind === 'unavailable') return { outcome: 'unavailable', reason: entry.reason, listeners: [], output: '' };

  const result = await probeRuntimeTraversal({
    cwd,
    entry: entry.file,
    nodeArgs: entry.nodeArgs,
    appArgs: entry.appArgs,
    timeoutMs: options.timeoutMs,
    settleMs: options.settleMs,
    platform: options.platform,
  });

  return { ...result, entry: { file: relative(cwd, entry.file).replace(/\\/g, '/'), from: entry.from } };
}

/**
 * 0 proven, 1 observed and not traversed, 2 could not be established.
 *
 * `unavailable` is deliberately its own code rather than folded into either neighbour: a caller that
 * treats it as success ships an unverified app believing it verified one, and a caller that treats it as
 * failure fails apps whose entry this cannot start — which is most TypeScript projects.
 */
export function runtimeExitCode(report: RuntimeCheckReport): 0 | 1 | 2 {
  if (report.outcome === 'proven') return 0;

  return report.outcome === 'not-traversed' ? 1 : 2;
}

/** The lines the CLI prints. Kept here so what the command says is covered by tests. */
export function formatRuntimeCheck(report: RuntimeCheckReport): string[] {
  const lines = ['runtime traversal (--runtime):'];
  if (report.entry) lines.push(`  entry: ${report.entry.file} (from ${report.entry.from})`);

  for (const listener of report.listeners) {
    const mark = listener.outcome === 'traversed' ? '✓' : listener.outcome === 'answered-without-sentinel' ? '✗' : '?';
    const note =
      listener.outcome === 'traversed'
        ? 'runtime traversal reached the scaffolded guard seam'
        : listener.outcome === 'answered-without-sentinel'
          ? 'the listener answered and the guard seam did not'
          : (listener.detail ?? 'could not be reached');
    // The address that was actually bound, not the one this hoped for: a line that prints a fixed
    // loopback address would read the same whatever the app did.
    const authority = listener.host.includes(':') ? `[${listener.host}]` : listener.host;
    lines.push(`  ${mark} ${listener.scheme}://${authority}:${listener.port} — ${note}`);
  }

  if (report.outcome === 'proven') {
    lines.push('runtime traversal reached the scaffolded guard seam ✓');
  } else if (report.outcome === 'not-traversed') {
    lines.push('runtime traversal did NOT reach the scaffolded guard seam ✗');
  } else {
    // Neither verdict. The reason is always printed, because "could not be established" without a cause
    // is the kind of line people learn to scroll past.
    lines.push(`? runtime traversal could not be established — ${report.reason ?? 'no reason given'}`);
    lines.push('  This is not a failure. The structural checks above still stand on their own.');
  }

  if (report.outcome !== 'proven' && report.output.trim() !== '') {
    lines.push('  the app printed:');
    for (const line of report.output.trim().split('\n').slice(0, 20)) lines.push(`    ${line}`);
  }

  return lines;
}
