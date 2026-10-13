import { describe, expect, it } from 'vitest';

import type { PackageSummary } from '../src/client.js';
import { readFileSync } from 'node:fs';

import { renderStatus, renderSummary, SUMMARY_HEADING, type StatusReport } from '../src/report.js';
import type { NextStepContext, Progress } from '../src/progress.js';

const context: NextStepContext = {
  installCommand: 'npm install --save @patchstack/connect',
  siteUuid: '550e8400-e29b-41d4-a716-446655440000',
  claimUrl: 'https://app.example.com/monitor/claim?site=550e8400-e29b-41d4-a716-446655440000',
  environment: 'local',
  environmentSource: null,
};

const notConnected: Progress = { installed: true, connected: false, synced: true, deployed: false };

const summary = (overrides: Partial<PackageSummary> = {}): PackageSummary => ({
  vulnerable: 3,
  outdated: 12,
  total: 89,
  severity: { high: 1, medium: 3, low: 1, unknown: 0 },
  ...overrides,
});

const report = (overrides: Partial<StatusReport> = {}): StatusReport => ({
  done: ['Checked 89 packages', 'Added this project to Patchstack'],
  missing: [
    { key: 'not-connected', text: 'Not connected to your Patchstack account', hint: ['Until it is, anyone can connect it.'] },
    {
      key: 'runtime-restart',
      text: 'Load the new protection in your running app',
      hint: ['Restart the preview/server.'],
      plain: { text: 'Restart your app to turn protection on', hint: ['Your live app gets it on your next deploy.'] },
    },
  ],
  checked: 89,
  findings: summary(),
  ...overrides,
});

describe('renderStatus concise', () => {
  it('puts what to do first, then the checklist, the link in a box, the findings and the menu', () => {
    const lines = renderStatus('Patchstack setup', report({ rules: 12 }), notConnected, context, {
      useColor: false,
      concise: true,
      menu: [{ command: 'npx @patchstack/connect vulns', does: 'vulnerability details' }],
    });
    const title = '➜ Next: connect your Patchstack account to see the details and turn on protection';
    const url = `  ${context.claimUrl}`;
    const inner = Math.max(title.length, url.length);

    expect(lines).toEqual([
      'Patchstack checked 89 packages',
      '',
      'To do',
      ' ✘ Restart your app to turn protection on',
      '   Your live app gets it on your next deploy.',
      '',
      ' ✔ Patchstack installed',
      ' ✘ Connect your Patchstack account',
      ' ✔ Packages checked on this computer',
      ' ✘ Deploy to protect your live app',
      '',
      `╭${'─'.repeat(inner + 2)}╮`,
      `│ ${title.padEnd(inner)} │`,
      `│ ${url.padEnd(inner)} │`,
      `╰${'─'.repeat(inner + 2)}╯`,
      '  Already connected? Run: npx @patchstack/connect go-live',
      '',
      ' ⚠ 5 vulnerabilities in 3 packages',
      '',
      '   High     ███████░░░░░░░░░░░░░  1',
      '   Medium   ████████████████████  3',
      '   Low      ███████░░░░░░░░░░░░░  1',
      '',
      '   12 packages are outdated',
      '   12 protection rules available',
      '',
      'More  npx @patchstack/connect vulns  vulnerability details',
    ]);
  });

  it('keeps the usual next step when nothing vulnerable was found', () => {
    const lines = renderStatus(
      'Patchstack setup',
      report({ findings: null }),
      notConnected,
      context,
      { useColor: false, concise: true },
    );

    expect(lines.some((line) => line.includes('➜ Next: connect your Patchstack account to turn on protection'))).toBe(true);
    expect(lines.some((line) => line.includes('⚠'))).toBe(false);
  });

  it('leaves out the restart while protection is not in place yet', () => {
    const lines = renderStatus(
      'Patchstack setup',
      report({
        missing: [
          ...report().missing,
          { key: 'runtime-protection', text: 'Runtime protection: no server file found', plain: { text: 'Protection needs to know where your server starts' } },
        ],
      }),
      notConnected,
      context,
      { useColor: false, concise: true },
    );

    expect(lines).toContain(' ✘ Protection needs to know where your server starts');
    expect(lines.some((line) => line.includes('Restart your app'))).toBe(false);
  });

  it('prints the full report with --verbose', () => {
    const lines = renderStatus('Patchstack setup', report(), notConnected, context, {
      useColor: false,
      concise: true,
      verbose: true,
    });

    expect(lines[0]).toBe('Patchstack setup');
    expect(lines).toContain('Done');
    expect(lines).toContain(' ✘ Not connected to your Patchstack account');
  });

  it('leaves the default report unchanged', () => {
    const lines = renderStatus('Patchstack setup', report(), notConnected, context, { useColor: false });

    expect(lines.slice(0, 5)).toEqual([
      'Patchstack setup',
      '',
      'Done',
      ' ✔ Checked 89 packages',
      ' ✔ Added this project to Patchstack',
    ]);
    expect(lines.some((line) => line.includes('⚠'))).toBe(false);
  });
});

const noServerItem = {
  key: 'runtime-protection',
  text: 'Runtime protection: no server file found',
  note: true,
  plain: {
    text: 'Blocking attacks needs a server, and none was found, so Patchstack checks your packages only.',
    hint: ['Has your app got a server? Run: npx @patchstack/connect protect'],
  },
};

describe('an app with no server', () => {
  it('shows the missing server as something to know, not a step left undone, and promises no protection', () => {
    const lines = renderStatus('Patchstack setup', report({ missing: [noServerItem] }), notConnected, context, { useColor: false, concise: true });

    expect(lines).not.toContain('To do');
    expect(lines).toContain('  ℹ Blocking attacks needs a server, and none was found, so Patchstack checks your packages only.');
    expect(lines.some((line) => line.includes('➜ Next: connect your Patchstack account to see the details '))).toBe(true);
    expect(lines.some((line) => line.includes('turn on protection'))).toBe(false);
  });
});

describe('renderSummary', () => {
  it('writes the message to pass on: findings, what to do with the full link, progress, and the reminder', () => {
    const lines = renderSummary(report({ rules: 12 }), notConnected, context, { widgetOnPage: true });

    expect(lines).toEqual([
      '### 🛡️ Patchstack is set up',
      '',
      '**Checked 89 packages: 5 vulnerabilities in 3 packages (highest severity: high).** 12 protection rules available.',
      '',
      '#### 👉 What to do now',
      '1. **Connect your Patchstack account** to see the details and turn on protection',
      `   ${context.claimUrl}`,
      '2. Restart your app to turn protection on',
      '',
      '#### What Patchstack found',
      '🔴 High **1** · 🟠 Medium **3** · 🔵 Low **1** · 12 packages outdated · 12 protection rules available',
      '',
      '#### Progress',
      '✅ Patchstack installed',
      '⬜ Connect your Patchstack account',
      '✅ Packages checked on this computer',
      '⬜ Deploy to protect your live app',
      '',
      '**Vulnerability overview:** a Patchstack widget now appears in the pre-production version of your app. Refresh the preview if it did not appear.',
      '',
      '#### Want more?',
      '- **See the vulnerabilities again:** `npx @patchstack/connect vulns`',
      '- **Go live on your host:** `npx @patchstack/connect go-live`',
      '',
      "Don't forget to republish or redeploy the app so the protection rules protect your live app.",
    ].join('\n').split('\n'));
  });

  it('makes no protection claims for an app with no server', () => {
    const text = renderSummary(report({ rules: 12, missing: [noServerItem] }), notConnected, context, { widgetOnPage: false }).join('\n');

    expect(text).not.toMatch(/protection rules|turn on protection|Restart your app/);
    expect(text).toContain('Blocking attacks needs a server, and none was found');
    expect(text).toContain("Don't forget to republish or redeploy the app when you're ready.");
    expect(text).not.toContain('Vulnerability overview');
    expect(text).toContain('- **Add the Patchstack widget to your app:** `npx @patchstack/connect widget`');
  });

  it('lists every command it offers in AGENT-INSTALL.md, so an assistant knows what each one does', () => {
    const doc = readFileSync(new URL('../AGENT-INSTALL.md', import.meta.url), 'utf8');
    const table = doc.slice(doc.indexOf('### Commands for later'), doc.indexOf('Say only what the output says.'));
    const summary = renderSummary(report(), notConnected, context, { widgetOnPage: false }).join('\n');
    for (const command of summary.match(/`npx @patchstack\/connect [a-z-]+`/g) ?? []) {
      expect(table, command).toContain(command);
    }
  });

  it('never states a count the run did not get', () => {
    const lines = renderSummary(report({ findings: null }), notConnected, context, { widgetOnPage: false });
    expect(lines[2]).toBe('**Checked 89 packages.** Patchstack is now watching them.');
  });
});

describe('the summary heading', () => {
  it('is the one AGENT-INSTALL.md tells an assistant to pass on, in the usual path and the plain HTML path', () => {
    const doc = readFileSync(new URL('../AGENT-INSTALL.md', import.meta.url), 'utf8');
    const usualPath = doc.slice(doc.indexOf('### JS/Node applications — the usual path'), doc.indexOf('## Before you start'));
    const plainHtml = doc.slice(doc.indexOf('#### Creating a Node project for a plain HTML site'), doc.indexOf('### JS/Node applications — the usual path'));
    for (const section of [doc.slice(0, doc.indexOf('## Choose the project path first')), usualPath, plainHtml]) {
      expect(section).toContain(`\`${SUMMARY_HEADING}\``);
    }
  });
});
