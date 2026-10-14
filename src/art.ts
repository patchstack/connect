// Terminal drawing for the concise report and `vulns`: a box around the one link to open, and a bar
// chart of what was found. Every function takes `useColor` and degrades to plain characters, so a
// log, a pipe or NO_COLOR gets the same layout without escape codes.

import type { PackageSummary } from './client.js';

const ANSI = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  cyan: '\u001B[36m',
  green: '\u001B[32m',
  // The two greens of the Patchstack mark, as the nearest 256-colour codes so every terminal shows them.
  brandDark: '\u001B[38;5;106m',
  brandLight: '\u001B[38;5;148m',
};

export type Paint = (code: keyof typeof ANSI, text: string) => string;

export function painter(useColor: boolean): Paint {
  return (code, text) => (useColor ? `${ANSI[code]}${text}${ANSI.reset}` : text);
}

/** A line of a box: its plain text, which sets the width, and how to paint it. */
export interface BoxLine {
  text: string;
  style?: keyof typeof ANSI;
}

/**
 * Draw a rounded box around the lines. Wider than the terminal, the side borders would wrap and break
 * the drawing, so it falls back to a rule above and below: a URL must never be split by a border.
 */
export function renderBox(lines: BoxLine[], options: { useColor: boolean; columns?: number; accent?: keyof typeof ANSI }): string[] {
  const paint = painter(options.useColor);
  const accent = options.accent ?? 'cyan';
  const inner = Math.max(...lines.map((line) => line.text.length));
  const width = inner + 4;
  const body = (line: BoxLine): string => (line.style !== undefined ? paint(line.style, line.text) : line.text);

  if (options.columns !== undefined && width > options.columns) {
    const rule = paint(accent, '─'.repeat(Math.max(1, options.columns - 1)));
    return [rule, ...lines.map((line) => ` ${body(line)}`), rule];
  }
  return [
    paint(accent, `╭${'─'.repeat(width - 2)}╮`),
    ...lines.map((line) => `${paint(accent, '│')} ${body(line)}${' '.repeat(inner - line.text.length)} ${paint(accent, '│')}`),
    paint(accent, `╰${'─'.repeat(width - 2)}╯`),
  ];
}

const SEVERITIES = [
  { level: 'high', label: 'High', color: 'red' },
  { level: 'medium', label: 'Medium', color: 'yellow' },
  { level: 'low', label: 'Low', color: 'blue' },
  { level: 'unknown', label: 'Unrated', color: 'dim' },
] as const;

const BAR_WIDTH = 20;

/**
 * What was found, as a heading and one bar per severity. Nothing when there is no summary, or it counts
 * no packages: the counts can trail the report by a moment, and an empty chart from a summary that has
 * not caught up would read as an all-clear.
 *
 * The severity buckets count vulnerabilities, not packages, so the heading says both numbers and the
 * bars are labelled as vulnerabilities.
 */
export function renderFindings(summary: PackageSummary | null, options: { useColor: boolean }): string[] {
  if (summary === null || summary.total === 0) return [];
  const paint = painter(options.useColor);
  const lines: string[] = [];

  const vulnerabilities = SEVERITIES.reduce((sum, { level }) => sum + summary.severity[level], 0);
  if (summary.vulnerable === 0) {
    lines.push(` ${paint('green', '✔')} ${paint('bold', 'No known vulnerabilities')} in your ${summary.total} packages`);
  } else {
    const inPackages = `${summary.vulnerable} ${summary.vulnerable === 1 ? 'package' : 'packages'}`;
    lines.push(
      ` ${paint('red', '⚠')} ${paint('bold', `${vulnerabilities} ${vulnerabilities === 1 ? 'vulnerability' : 'vulnerabilities'}`)} in ${inPackages}`,
      '',
    );
    const most = Math.max(...SEVERITIES.map(({ level }) => summary.severity[level]));
    const labelWidth = Math.max(...SEVERITIES.map(({ label }) => label.length));
    for (const { level, label, color } of SEVERITIES) {
      const count = summary.severity[level];
      if (count === 0 && level === 'unknown') continue;
      const filled = count === 0 ? 0 : Math.max(1, Math.round((count / most) * BAR_WIDTH));
      const bar = paint(color, '█'.repeat(filled)) + paint('dim', '░'.repeat(BAR_WIDTH - filled));
      lines.push(`   ${label.padEnd(labelWidth)}  ${bar}  ${count}`);
    }
  }
  if (summary.outdated > 0) {
    if (summary.vulnerable > 0) lines.push('');
    lines.push(`   ${paint('dim', `${summary.outdated} ${summary.outdated === 1 ? 'package is' : 'packages are'} outdated`)}`);
  }
  return lines;
}

/** A short menu of follow-up commands, each with what it is for. */
export function renderMenu(items: Array<{ command: string; does: string }>, options: { useColor: boolean }): string[] {
  if (items.length === 0) return [];
  const paint = painter(options.useColor);
  const width = Math.max(...items.map((item) => item.command.length));
  return items.map((item, index) =>
    `${index === 0 ? paint('bold', 'More') : '    '}  ${paint('cyan', item.command.padEnd(width))}  ${paint('dim', item.does)}`,
  );
}

/**
 * The banner `setup` opens with in a person's terminal: the Patchstack mark drawn in half blocks, then the
 * name. Never printed into a pipe, a build log or CI, where an assistant or a log reader would only pay for
 * it in lines.
 */
export function renderLogo(options: { useColor: boolean }): string[] {
  const paint = painter(options.useColor);
  const dark = (text: string): string => paint('brandDark', text);
  const light = (text: string): string => paint('brandLight', text);
  return [
    ` ${dark('████')}${light('████')}  ${paint('bold', 'patchstack')}`,
    ` ${light('▄▄')}${dark('▄▄')}${light('▀▀▀▀')}  ${paint('dim', "Checking your app's packages for known vulnerabilities")}`,
    '',
  ];
}
