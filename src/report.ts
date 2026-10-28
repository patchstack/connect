// The plain status report `setup`, `scan` and `guide` print: what this run did, what is still missing,
// then the progress checklist and the one next step. Technical detail is not part of it; the commands
// print that only with --verbose.

import { renderBox, renderFindings, renderMarkdownLogo, renderMenu } from './art.js';
import type { PackageSummary } from './client.js';
import { SECRET_CONFIG_FILENAME } from './config.js';
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
  /** Something to know rather than something to do: shown without a ✘ in the concise report. */
  note?: boolean;
}

export interface StatusReport {
  done: string[];
  /** Short verified outcomes that stay visible in concise output and the assistant summary. */
  confirmed?: string[];
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

  if (protectionPossible(report) && report.confirmed?.length) {
    lines.push(...report.confirmed.map((text) => ` ${paint(ANSI.green, '✔')} ${text}`), '');
  }

  // Every file this run changed, one line each. The Markdown summary says only the part the person acts on.
  const changed = groupChanges(report.changed ?? []);
  if (changed.length > 0) {
    lines.push(paint(ANSI.bold, 'Changed'), ...changed.map(({ files, what }) => `  ${files.map((file) => `\`${file}\``).join(', ')}: ${paint(ANSI.dim, what)}`), '');
  }

  for (const item of report.missing.filter((entry) => entry.note === true)) {
    lines.push(`  ${paint(ANSI.dim, 'ℹ')} ${item.plain?.text ?? item.text}`);
    for (const hint of item.plain?.hint ?? item.hint ?? []) lines.push(`    ${paint(ANSI.dim, hint)}`);
    lines.push('');
  }

  lines.push(...renderMenu(options.menu ?? [], { useColor: options.useColor }));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Changes by file, with files that got the same description sharing one entry. */
function groupChanges(changes: Array<{ file: string; what: string }>): Array<{ files: string[]; what: string }> {
  const byFile = new Map<string, string[]>();
  for (const { file, what } of changes) {
    const items = byFile.get(file) ?? [];
    if (!items.includes(what)) items.push(what);
    byFile.set(file, items);
  }
  const byWhat = new Map<string, string[]>();
  for (const [file, items] of byFile) {
    const what = items.join('; ');
    byWhat.set(what, [...(byWhat.get(what) ?? []), file]);
  }
  return [...byWhat].map(([what, files]) => ({ files, what }));
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

/** The word the person says to hear what comes next; `next` answers it. AGENT-INSTALL.md lists it. */
export const NEXT_REPLY = 'done';

/** The line the summary starts after. AGENT-INSTALL.md names it, so an assistant knows what to pass on. */
export const SUMMARY_HEADING = '──── Summary ────';

/** The line printed just before the summary, saying what it is for. */
export const SUMMARY_INTRO = `Setup is finished. The person may not see this command's output, only your reply. The summary below is written for them: put it in your final message exactly as written, with every section. When they say "${NEXT_REPLY}", run npx @patchstack/connect next.`;

/**
 * The line setup's output ends on, after the summary. It is the line an assistant is surest to read, so it
 * repeats what the intro asks and, while the site has no owner, carries the link the person needs: an
 * assistant that reports only that the command succeeded leaves them with no way to see their results.
 */
export function summaryClosingLine(connected: boolean, claimUrl: string | null): string {
  return !connected && claimUrl !== null
    ? `Your reply to the person must include the summary above, as written, with this link to connect their Patchstack account: ${claimUrl}`
    : 'Your reply to the person must include the summary above, as written: it is their result and their next step.';
}

export interface SummaryOptions {
  /** The widget tag is on the page, so the summary says where to see it. */
  widgetOnPage: boolean;
}

/**
 * The same report as a short Markdown message, ready to be passed on as it is: the Patchstack mark, a
 * headline with what was found, the one thing to do now with its link written out in full, and the word
 * to say once it is done, which `next` answers. It is built from this run's results only, so it never says
 * more than the report above it, and a part with nothing new to say is left out.
 */
export function renderSummary(report: StatusReport, progress: Progress, context: NextStepContext, options: SummaryOptions): string[] {
  const findings = report.findings ?? null;
  const counted = findings !== null && findings.total > 0;
  const checked = report.checked !== undefined ? `Checked ${report.checked} ${report.checked === 1 ? 'package' : 'packages'}` : null;
  const canProtect = protectionPossible(report);
  context = { ...context, noServer: !canProtect };

  const rules = canProtect && (report.rules ?? 0) > 0 ? `${report.rules} protection ${report.rules === 1 ? 'rule' : 'rules'} available` : null;
  let headline: string;
  if (counted && findings.vulnerable > 0) {
    const vulnerabilities = findings.severity.high + findings.severity.medium + findings.severity.low + findings.severity.unknown;
    const worst = (['high', 'medium', 'low'] as const).find((level) => findings.severity[level] > 0);
    headline = `${checked ?? 'Patchstack'}: ${vulnerabilities} ${vulnerabilities === 1 ? 'vulnerability' : 'vulnerabilities'} in ${findings.vulnerable} ${findings.vulnerable === 1 ? 'package' : 'packages'}${worst !== undefined ? ` (highest severity: ${worst})` : ''}`;
  } else if (counted) {
    headline = `${checked ?? 'Patchstack'}: no known vulnerabilities`;
  } else {
    headline = checked !== null ? `${checked}, now watching them` : 'Patchstack is now watching your app';
  }

  const lines = [...renderMarkdownLogo(), `### 🛡️ ${headline}`, ''];
  // With counts, the protection rules are listed under what was found; without them, they go here.
  if (rules !== null && !counted) lines.push(`${rules}.`, '');

  // One step, the person's: the steps an assistant can take itself stay in the report above the summary.
  const next = nextProgressStep(progress);
  if (next !== null) {
    const vulnerable = (findings?.vulnerable ?? 0) > 0;
    const rest =
      next !== 'connected' ? '' : !canProtect ? ' to see the details' : vulnerable ? ' to see the details and turn on protection' : ' to turn on protection';
    const lead = next === 'connected' ? 'Connect your Patchstack account' : capitalise(plainNextStepTitle(next, context));
    const [first] = plainNextStepLines(next, context);
    const action = first?.startsWith('Open ') === true ? first.slice('Open '.length) : first;
    // The link goes in a paragraph of its own, so it renders on its own line.
    lines.push(`#### 👉 ${lead}${rest}`, '', ...(action !== undefined ? [action, ''] : []));
    lines.push(next === 'connected' ? `When you've connected, say **${NEXT_REPLY}**.` : `When that's done, say **${NEXT_REPLY}**.`, '');
  }

  if (canProtect && report.confirmed?.length) {
    lines.push('#### Protection checks', ...report.confirmed, '');
  }

  const outdated = findings?.outdated ?? 0;
  // With nothing found, the headline already says it all.
  if (counted && (findings.vulnerable > 0 || outdated > 0 || rules !== null)) {
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
      ...(rules !== null ? [rules] : []),
    ];
    lines.push('#### What Patchstack found', parts.join(' · '), '');
  }

  if (options.widgetOnPage) lines.push("**Refresh your app's preview** to see the Patchstack widget.", '');
  // A fact about the app, not a step: the ones that matter here are what protection does not cover.
  for (const item of report.missing.filter((entry) => entry.note === true && entry.key !== 'runtime-protection')) {
    lines.push(item.plain?.text ?? item.text, '');
  }

  // The person is owed an account of what changed. The setup output above lists every file; here it is
  // the part they act on, so an assistant has no reason to write its own list next to the summary.
  const changed = report.changed ?? [];
  const scripts = changed.find(({ file, what }) => file === 'package.json' && (what === BUILD_SCRIPTS_CHANGE || what === INSTALL_SCRIPT_CHANGE));
  const key = changed.some(({ file }) => file === SECRET_CONFIG_FILENAME);
  const account = [
    ...(scripts !== undefined ? [`Patchstack is now part of your ${scripts.what === BUILD_SCRIPTS_CHANGE ? 'install and build' : 'install'}.`] : []),
    ...(key ? [`Your API key is in \`${SECRET_CONFIG_FILENAME}\`: git ignores it, so never share it.`] : []),
  ];
  if (account.length > 0) lines.push(`_${account.join(' ')}_`, '');

  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** What the person can ask, in a later conversation, to see this summary again. AGENT-INSTALL.md lists it. */
export const SUMMARY_AGAIN = 'Show my Patchstack summary';

/** What `setup` records for `package.json` when it wires the scripts, which the summary recognises. */
export const BUILD_SCRIPTS_CHANGE = 'Patchstack in the install and build scripts';
export const INSTALL_SCRIPT_CHANGE = 'a package check after each install';

/** The line printed before what `next` says, saying what it is for. */
export const NEXT_INTRO = `The person may not see this command's output, only your reply. The message below is written for them: put it in your reply as written. When they say "${NEXT_REPLY}" again, run npx @patchstack/connect next again.`;

export interface NextOptions {
  /** The link to connect the site, or its dashboard once connected. */
  link: string | null;
  /** The go-live steps for the project's host, as `go-live` prints them without colour; null when the host is not known. */
  goLive: string[] | null;
  /** The hosts `go-live --host` knows, by name, to ask which one when the host is not known. */
  hosts: string[];
}

/**
 * What `next` says: where the project stands and the one thing to do now, ending on the word to say once
 * it is done. Connecting is the only step the CLI can see completed; deploying is shown in the dashboard.
 */
export function renderNext(progress: Progress, context: NextStepContext, options: NextOptions): string[] {
  const next = nextProgressStep(progress);
  if (next === 'connected') {
    return [
      "### ⏳ Your Patchstack account isn't connected yet",
      '',
      ...(options.link !== null ? [options.link, ''] : []),
      `When you've connected, say **${NEXT_REPLY}**.`,
    ];
  }

  const lines = [progress.connected ? '### ✅ Your Patchstack account is connected' : '### 🛡️ Patchstack', ''];
  if (progress.connected && options.link !== null) lines.push(`See what Patchstack found in your dashboard: ${options.link}`, '');
  if (next === null) return [...lines, 'Nothing else to do.'];

  lines.push(`#### 👉 ${capitalise(plainNextStepTitle(next, context))}`, '');
  if (next === 'deployed' && context.environment !== 'production') {
    if (options.goLive === null) {
      const names = `${options.hosts.slice(0, -1).join(', ')} or ${options.hosts[options.hosts.length - 1]}`;
      return [...lines, `Where is your app hosted? Say its name: ${names}.`];
    }
    lines.push('```', ...options.goLive, '```', '', '_Your Patchstack dashboard shows your live app once it reports in._');
    return lines;
  }
  lines.push(...nextStepLines(next, context), '');
  if (next === 'deployed') return [...lines, '_Your Patchstack dashboard shows your live app once it reports in._'];
  return [...lines, `When that's done, say **${NEXT_REPLY}**.`];
}

/** False when setup found no server, so there is no protection for the app to turn on. */
function protectionPossible(report: StatusReport): boolean {
  return !report.missing.some((item) => item.note === true && item.key === 'runtime-protection');
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
