// The plain status report `setup`, `scan` and `guide` print: what this run did, what is still missing,
// then the progress checklist and the one next step. Technical detail is not part of it; the commands
// print that only with --verbose.

import {
  nextProgressStep,
  nextStepLines,
  nextStepTitle,
  renderProgress,
  type NextStepContext,
  type Progress,
} from './progress.js';

export interface MissingItem {
  /** Items with the same key say the same thing; the first one reported is kept. Defaults to `text`. */
  key?: string;
  /** What is missing, in one short sentence. */
  text: string;
  /** What to do about it, one line each. */
  hint?: string[];
  /** Technical lines printed under the hint only with --verbose. */
  detail?: string[];
}

export interface StatusReport {
  done: string[];
  missing: MissingItem[];
}

export function emptyReport(): StatusReport {
  return { done: [], missing: [] };
}

const ANSI = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
};

export interface RenderStatusOptions {
  useColor: boolean;
  verbose?: boolean;
  /** Leave out the checklist and the next step, for a caller that prints its own. */
  withoutProgress?: boolean;
}

export function renderStatus(
  title: string,
  report: StatusReport,
  progress: Progress,
  context: NextStepContext,
  options: RenderStatusOptions,
): string[] {
  const paint = (code: string, text: string): string =>
    options.useColor ? `${code}${text}${ANSI.reset}` : text;
  const lines: string[] = [paint(ANSI.bold, title), ''];

  if (report.done.length > 0) {
    lines.push(paint(ANSI.bold, 'Done'));
    for (const item of report.done) lines.push(` ${paint(ANSI.green, '✔')} ${item}`);
    lines.push('');
  }

  if (report.missing.length > 0) {
    lines.push(paint(ANSI.bold, 'Missing'));
    for (const item of report.missing) {
      lines.push(` ${paint(ANSI.yellow, '✘')} ${item.text}`);
      for (const hint of item.hint ?? []) lines.push(`   ${hint}`);
      if (options.verbose === true) {
        for (const detail of item.detail ?? []) lines.push(`   ${paint(ANSI.dim, detail)}`);
      }
    }
    lines.push('');
  }

  if (options.withoutProgress === true) {
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  lines.push(...renderProgress(progress, context, { useColor: options.useColor }));
  return lines;
}

/**
 * The same report for a build log: one line for what was done and one for what to do next. A build
 * hook runs on every install and build, where the full checklist is noise nobody reads.
 */
export function renderHookSummary(report: StatusReport, progress: Progress, context: NextStepContext): string[] {
  const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
  const lines: string[] = [];

  if (report.done.length > 0) {
    lines.push(`Patchstack: ${report.done.map(lowerFirst).join('; ')}.`);
  }

  const next = nextProgressStep(progress);
  if (next !== null) {
    // A production build is the publish itself; the title already says the one thing left.
    const first =
      next === 'deployed' && context.environment === 'production' ? undefined : nextStepLines(next, context)[0];
    lines.push(`Patchstack next step: ${nextStepTitle(next, context)}.${first !== undefined ? ` ${first}` : ''}`);
  }
  return lines;
}
