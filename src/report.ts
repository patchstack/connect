// The plain status report `setup`, `scan` and `guide` print: what this run did, what is still missing,
// then the progress checklist and the one next step. Technical detail is not part of it; the commands
// print that only with --verbose.

import { renderBox, renderFindings, renderMenu } from './art.js';
import type { PackageSummary } from './client.js';
import {
  nextProgressStep,
  nextStepLines,
  nextStepTitle,
  plainNextStepLines,
  plainNextStepTitle,
  renderChecklist,
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
  /** The same item in plain words, for the concise report. */
  plain?: { text: string; hint?: string[] };
}

export interface StatusReport {
  done: string[];
  missing: MissingItem[];
  /** How many packages this run checked, when it checked any. */
  checked?: number;
  /** What Patchstack found, when it said. */
  findings?: PackageSummary | null;
}

export function emptyReport(): StatusReport {
  return { done: [], missing: [] };
}

/** Keys of missing items the checklist already says, left out of the concise report. */
export const COVERED_BY_CHECKLIST: ReadonlySet<string> = new Set(['not-connected']);

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
  /** What is left to do, the checklist, the next step and the findings; what was done only with --verbose. */
  concise?: boolean;
  /** Follow-up commands the concise report lists last. */
  menu?: Array<{ command: string; does: string }>;
  /** Terminal width, when known; the concise report's box fits inside it. */
  columns?: number;
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
  if (options.concise === true && options.verbose !== true) {
    return renderConcise(title, report, progress, context, options, paint);
  }
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

function renderConcise(
  title: string,
  report: StatusReport,
  progress: Progress,
  context: NextStepContext,
  options: RenderStatusOptions,
  paint: (code: string, text: string) => string,
): string[] {
  const heading = report.checked !== undefined ? `Patchstack checked ${report.checked} ${report.checked === 1 ? 'package' : 'packages'}` : title;
  const lines: string[] = [paint(ANSI.bold, heading), ''];

  // What the person has to do comes first, then where they stand, then the one link, then what was found.
  const keys = new Set(report.missing.map((item) => item.key ?? item.text));
  const todo = report.missing.filter((item) => {
    const key = item.key ?? item.text;
    if (COVERED_BY_CHECKLIST.has(key)) return false;
    // Restarting loads protection that is in place; while it is not, the restart would load nothing.
    return !(key === 'runtime-restart' && keys.has('runtime-protection'));
  });
  if (todo.length > 0) {
    lines.push(paint(ANSI.bold, 'To do'));
    for (const item of todo) {
      lines.push(` ${paint(ANSI.yellow, '✘')} ${item.plain?.text ?? item.text}`);
      for (const hint of item.plain?.hint ?? item.hint ?? []) lines.push(`   ${paint(ANSI.dim, hint)}`);
    }
    lines.push('');
  }

  if (options.withoutProgress !== true) {
    lines.push(...renderChecklist(progress, context, { useColor: options.useColor, plain: true }), '');
    lines.push(...nextStepBox(report, progress, context, options), '');
  }

  const findings = renderFindings(report.findings ?? null, { useColor: options.useColor });
  if (findings.length > 0) lines.push(...findings, '');

  lines.push(...renderMenu(options.menu ?? [], { useColor: options.useColor }));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The next step in a box: its title and the link or command to use. Any further lines follow below it. */
function nextStepBox(
  report: StatusReport,
  progress: Progress,
  context: NextStepContext,
  options: RenderStatusOptions,
): string[] {
  const next = nextProgressStep(progress);
  if (next === null) {
    return renderBox([{ text: '✔ All done.', style: 'green' }], { useColor: options.useColor, columns: options.columns, accent: 'green' });
  }
  // With findings to show, connecting is how a person sees which packages they are, so the step says that.
  const vulnerable = (report.findings?.vulnerable ?? 0) > 0;
  const title = vulnerable && next === 'connected' ? 'see which packages and how to fix them' : plainNextStepTitle(next, context);
  const [first, ...rest] = plainNextStepLines(next, context);
  const action = first?.startsWith('Open ') === true ? first.slice('Open '.length) : first;
  return [
    ...renderBox(
      [{ text: `➜ Next: ${title}`, style: 'bold' }, ...(action !== undefined ? [{ text: `  ${action}`, style: 'cyan' as const }] : [])],
      { useColor: options.useColor, columns: options.columns },
    ),
    ...rest.map((line) => `  ${paint(ANSI.dim, line)}`),
  ];

  function paint(code: string, text: string): string {
    return options.useColor ? `${code}${text}${ANSI.reset}` : text;
  }
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
