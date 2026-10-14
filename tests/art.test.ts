import { describe, expect, it } from 'vitest';

import { renderBox, renderFindings, renderMenu, renderLogo } from '../src/art.js';
import type { PackageSummary } from '../src/client.js';

const summary = (overrides: Partial<PackageSummary> = {}): PackageSummary => ({
  vulnerable: 3,
  outdated: 12,
  total: 89,
  severity: { high: 1, medium: 3, low: 1, unknown: 0 },
  ...overrides,
});

describe('renderBox', () => {
  it('draws a box sized to the longest line', () => {
    expect(renderBox([{ text: 'Next' }, { text: '  https://x' }], { useColor: false })).toEqual([
      '╭─────────────╮',
      '│ Next        │',
      '│   https://x │',
      '╰─────────────╯',
    ]);
  });

  it('falls back to rules when the box is wider than the terminal, so a URL is never split by a border', () => {
    expect(renderBox([{ text: 'a long line here' }], { useColor: false, columns: 10 })).toEqual([
      '─────────',
      ' a long line here',
      '─────────',
    ]);
  });

  it('adds colour only when asked', () => {
    expect(renderBox([{ text: 'x' }], { useColor: false }).join('')).not.toContain('\u001B[');
    expect(renderBox([{ text: 'x' }], { useColor: true }).join('')).toContain('\u001B[');
  });
});

describe('renderFindings', () => {
  it('heads with vulnerabilities and packages, then one bar per severity scaled to the largest', () => {
    expect(renderFindings(summary(), { useColor: false })).toEqual([
      ' ⚠ 5 vulnerabilities in 3 packages',
      '',
      '   High     ███████░░░░░░░░░░░░░  1',
      '   Medium   ████████████████████  3',
      '   Low      ███████░░░░░░░░░░░░░  1',
      '',
      '   12 packages are outdated',
    ]);
  });

  it('shows unrated vulnerabilities only when there are some, and an empty bar for a zero count', () => {
    const lines = renderFindings(
      summary({ vulnerable: 1, outdated: 0, severity: { high: 0, medium: 0, low: 0, unknown: 2 } }),
      { useColor: false },
    );
    expect(lines[0]).toBe(' ⚠ 2 vulnerabilities in 1 package');
    expect(lines).toContain('   High     ░░░░░░░░░░░░░░░░░░░░  0');
    expect(lines).toContain('   Unrated  ████████████████████  2');
  });

  it('says a project with nothing vulnerable is clear', () => {
    expect(
      renderFindings(summary({ vulnerable: 0, outdated: 1, severity: { high: 0, medium: 0, low: 0, unknown: 0 } }), { useColor: false }),
    ).toEqual([' ✔ No known vulnerabilities in your 89 packages', '   1 package is outdated']);
  });

  it('says nothing when there is no summary or it has not counted any packages yet', () => {
    expect(renderFindings(null, { useColor: false })).toEqual([]);
    expect(renderFindings(summary({ vulnerable: 0, outdated: 0, total: 0 }), { useColor: false })).toEqual([]);
  });
});

describe('renderMenu', () => {
  it('lines up the commands under one heading', () => {
    expect(
      renderMenu(
        [
          { command: 'npx @patchstack/connect vulns', does: 'details' },
          { command: 'npx @patchstack/connect widget', does: 'add the widget' },
        ],
        { useColor: false },
      ),
    ).toEqual([
      'More  npx @patchstack/connect vulns   details',
      '      npx @patchstack/connect widget  add the widget',
    ]);
  });

  it('prints nothing for no items', () => {
    expect(renderMenu([], { useColor: false })).toEqual([]);
  });
});

describe('renderLogo', () => {
  it('draws the shield and name, with no escape codes when colour is off', () => {
    const lines = renderLogo({ useColor: false });
    expect(lines.join('\n')).toContain('patchstack');
    expect(lines.join('\n')).not.toContain('\u001B[');
    expect(lines.length).toBeLessThanOrEqual(4);
  });
});
