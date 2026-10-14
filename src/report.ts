// The plain status report `setup`, `scan` and `guide` print: what this run did, what is still missing,
// then the progress checklist and the one next step. Technical detail is not part of it; the commands
// print that only with --verbose.

import { renderBox, renderFindings, renderMenu } from './art.js';
import type { PackageSummary } from './client.js';
import {
  nextProgressStep,
  nextStepLines,
  nextStepTitle,
  PROGRESS_STEPS,
  plainNextStepLines,
  plainNextStepTitle,
  plainStepLabel,
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
  /** Something to know rather than something to do: shown without a ✘ in the concise report. */
  note?: boolean;
}

export interface StatusReport {
  done: string[];
  missing: MissingItem[];
  /** How many packages this run checked, when it checked any. */
  checked?: number;
  /** What Patchstack found, when it said. */
  findings?: PackageSummary | null;
  /** Protection rules Patchstack has ready for this app, when the run looked them up. */
  rules?: number;
  /** Files this run changed in the project, and what it put in each, for the person to know. */
  changed?: Array<{ file: string; what: string }>;
}

/** Note a file this run changed. */
export function recordChange(report: StatusReport, file: string, what: string): void {
  (report.changed ??= []).push({ file, what });
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
  context = { ...context, noServer: !protectionPossible(report) };
  const heading = report.checked !== undefined ? `Patchstack checked ${report.checked} ${report.checked === 1 ? 'package' : 'packages'}` : title;
  const lines: string[] = [paint(ANSI.bold, heading), ''];

  // What the person has to do comes first, then where they stand, then the one link, then what was found.
  const keys = new Set(report.missing.map((item) => item.key ?? item.text));
  const todo = report.missing.filter((item) => {
    const key = item.key ?? item.text;
    if (item.note === true || COVERED_BY_CHECKLIST.has(key)) return false;
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
  if (findings.length > 0) lines.push(...findings);
  if ((report.rules ?? 0) > 0) {
    const rules = report.rules!;
    lines.push(`   ${paint(ANSI.green, `${rules} protection ${rules === 1 ? 'rule' : 'rules'} available`)}`);
  }
  if (findings.length > 0 || (report.rules ?? 0) > 0) lines.push('');

  for (const item of report.missing.filter((entry) => entry.note === true)) {
    lines.push(`  ${paint(ANSI.dim, 'ℹ')} ${item.plain?.text ?? item.text}`);
    for (const hint of item.plain?.hint ?? item.hint ?? []) lines.push(`    ${paint(ANSI.dim, hint)}`);
    lines.push('');
  }

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
  // Without a server there is no protection to turn on, so the step does not promise one.
  const vulnerable = (report.findings?.vulnerable ?? 0) > 0;
  const title =
    next === 'connected' && !protectionPossible(report)
      ? 'connect your Patchstack account to see the details'
      : vulnerable && next === 'connected'
        ? 'connect your Patchstack account to see the details and turn on protection'
        : plainNextStepTitle(next, context);
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

/** The line the summary starts after. AGENT-INSTALL.md names it, so an assistant knows what to pass on. */
export const SUMMARY_HEADING = '──── Summary ────';

/** The line printed just before the summary, saying what it is for. */
export const SUMMARY_INTRO = 'Setup is finished. The summary below is written for the person: show it as your final message, exactly as written, with every section, ending with the numbered menu.';

export interface SummaryOptions {
  /** The widget tag is on the page, so the summary says where to see it. */
  widgetOnPage: boolean;
  /** The file the widget tag is in, relative to the project, when it was found. */
  widgetFile?: string | null;
}

/**
 * The same report as a short Markdown message, ready to be passed on as it is: a headline with what was
 * found, what to do now with the link written out in full, the four steps, one closing reminder, and a
 * numbered menu of what the person can ask for next. It is built from this run's results only, so it never says more than the report
 * above it, and a part with nothing new to say is left out.
 */
export function renderSummary(report: StatusReport, progress: Progress, context: NextStepContext, options: SummaryOptions): string[] {
  const findings = report.findings ?? null;
  const counted = findings !== null && findings.total > 0;
  const checked = report.checked !== undefined ? `Checked ${report.checked} ${report.checked === 1 ? 'package' : 'packages'}` : null;
  const canProtect = protectionPossible(report);
  context = { ...context, noServer: !canProtect };

  let headline: string;
  if (counted && findings.vulnerable > 0) {
    const vulnerabilities = findings.severity.high + findings.severity.medium + findings.severity.low + findings.severity.unknown;
    const worst = (['high', 'medium', 'low'] as const).find((level) => findings.severity[level] > 0);
    headline = `**${checked ?? 'Patchstack'}: ${vulnerabilities} ${vulnerabilities === 1 ? 'vulnerability' : 'vulnerabilities'} in ${findings.vulnerable} ${findings.vulnerable === 1 ? 'package' : 'packages'}${worst !== undefined ? ` (highest severity: ${worst})` : ''}.**`;
  } else if (counted) {
    headline = `**${checked ?? 'Patchstack'}: no known vulnerabilities.**`;
  } else {
    headline = checked !== null ? `**${checked}.** Patchstack is now watching them.` : '**Patchstack is now watching your app.**';
  }
  if (canProtect && (report.rules ?? 0) > 0) {
    headline += ` ${report.rules} protection ${report.rules === 1 ? 'rule' : 'rules'} available.`;
  }

  const lines = ['### 🛡️ Patchstack is set up', '', headline, ''];

  const todo: string[] = [];
  const next = nextProgressStep(progress);
  if (next !== null) {
    const vulnerable = (findings?.vulnerable ?? 0) > 0;
    const title =
      next === 'connected' && !canProtect
        ? 'Connect your Patchstack account** to see the details'
        : next === 'connected'
        ? vulnerable
          ? 'Connect your Patchstack account** to see the details and turn on protection'
          : 'Connect your Patchstack account** to turn on protection'
        : `${capitalise(plainNextStepTitle(next, context))}**`;
    const [first] = plainNextStepLines(next, context);
    const action = first?.startsWith('Open ') === true ? first.slice('Open '.length) : first;
    todo.push(`**${title}${action !== undefined ? `\n   ${action}` : ''}`);
  }
  for (const item of report.missing) {
    const key = item.key ?? item.text;
    if (item.note === true || COVERED_BY_CHECKLIST.has(key)) continue;
    if (key === 'runtime-restart' && !canProtect) continue;
    todo.push(item.plain?.text ?? item.text);
  }
  const outdated = findings?.outdated ?? 0;
  const steps = todo.slice(0, 3);
  if (steps.length > 0) {
    lines.push('#### 👉 What to do now');
    // A single step needs no number; its link goes in a paragraph of its own so it renders on its own line.
    if (steps.length === 1) lines.push(...steps[0]!.split('\n').flatMap((line, index) => (index === 0 ? [line] : ['', line.trimStart()])));
    else lines.push(...steps.flatMap((entry, index) => `${index + 1}. ${entry}`.split('\n')));
    lines.push('');
  }

  // With nothing found, the headline already says it all.
  if (counted && (findings.vulnerable > 0 || outdated > 0 || (canProtect && (report.rules ?? 0) > 0))) {
    const severity = (
      [
        ['🔴 High', findings.severity.high],
        ['🟠 Medium', findings.severity.medium],
        ['🔵 Low', findings.severity.low],
        ['⚪ Unrated', findings.severity.unknown],
      ] as const
    )
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${label} **${count}**`);
    const parts = [
      ...(severity.length > 0 ? severity : ['No known vulnerabilities']),
      ...(outdated > 0 ? [`${outdated} ${outdated === 1 ? 'package' : 'packages'} outdated`] : []),
      ...(canProtect && (report.rules ?? 0) > 0 ? [`${report.rules} protection ${report.rules === 1 ? 'rule' : 'rules'} available`] : []),
    ];
    lines.push('#### What Patchstack found', parts.join(' · '), '');
  }

  lines.push('#### Progress');
  for (const { step } of PROGRESS_STEPS) {
    lines.push(`${progress[step] ? '✅' : '⬜'} ${plainStepLabel(step, progress[step], context.environment, !canProtect)}`);
  }
  lines.push('');

  // The person is owed an account of what changed in their project. Written here, so an assistant has no
  // reason to write its own next to the summary.
  const changed = new Map<string, string[]>();
  for (const { file, what } of report.changed ?? []) {
    const items = changed.get(file) ?? [];
    if (!items.includes(what)) items.push(what);
    changed.set(file, items);
  }
  if (changed.size > 0) {
    lines.push('#### What changed in your project');
    for (const [file, items] of changed) lines.push(`- \`${file}\`: ${items.join('; ')}`);
    lines.push('');
  }

  if (options.widgetOnPage) {
    const where = options.widgetFile != null ? ` (in \`${options.widgetFile}\`)` : '';
    lines.push(`The Patchstack widget now shows in your app preview${where}. Refresh the preview if you don't see it.`, '');
  }
  for (const item of report.missing.filter((entry) => entry.note === true)) {
    lines.push(item.plain?.text ?? item.text, '');
  }
  // Without a server, publishing is already an option in the menu below, so there is nothing to remind.
  if (canProtect) lines.push("Don't forget to republish or redeploy the app so the protection rules protect your live app.", '');

  const replies = summaryReplies(report, progress, options);
  if (replies.length > 0) {
    lines.push('---', '', '### 💬 What next? Reply with a number', '');
    replies.forEach((reply, index) => {
      if (index > 0) lines.push('>');
      lines.push(`> ${KEYCAPS[index]} **${reply.reply}**`);
    });
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'] as const;

/** One thing the person can ask for after setup, and the command the assistant runs for it. */
export interface SummaryReply {
  reply: string;
  command: string;
}

/**
 * The menu the summary ends on: things the person can ask for by replying with a number, each answered by
 * a command AGENT-INSTALL.md lists. Only choices that apply to this run are offered.
 */
export function summaryReplies(report: StatusReport, progress: Progress, options: SummaryOptions): SummaryReply[] {
  const findings = report.findings ?? null;
  const nothingFound = findings !== null && findings.total > 0 && findings.vulnerable === 0 && findings.outdated === 0;
  const replies: SummaryReply[] = [];
  if (!nothingFound) {
    replies.push({
      reply: (findings?.vulnerable ?? 1) > 0 ? 'Show me the vulnerabilities' : 'Show me what Patchstack found',
      command: 'npx @patchstack/connect vulns',
    });
  }
  if (!progress.connected) replies.push({ reply: 'Check that my account is connected', command: 'npx @patchstack/connect status' });
  if (!options.widgetOnPage) replies.push({ reply: 'Add the Patchstack widget to my app', command: 'npx @patchstack/connect widget' });
  if (!progress.deployed) replies.push({ reply: 'Help me put my app live', command: 'npx @patchstack/connect go-live' });
  return replies.slice(0, KEYCAPS.length);
}

/** False when setup found no server, so there is no protection for the app to turn on. */
function protectionPossible(report: StatusReport): boolean {
  return !report.missing.some((item) => item.note === true && item.key === 'runtime-protection');
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
