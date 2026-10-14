import { describe, expect, it } from 'vitest';

import type { PackageSummary } from '../src/client.js';
import { readFileSync } from 'node:fs';

import { renderStatus, renderSummary, SUMMARY_HEADING, summaryReplies, type StatusReport } from '../src/report.js';
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
    text: 'No server was found in this project, so Patchstack checks its packages. Blocking attacks needs a server.',
    hint: ['Has your app got a server? Run: npx @patchstack/connect protect'],
  },
};

describe('an app with no server', () => {
  it('shows the missing server as something to know, not a step left undone, and promises no protection', () => {
    const lines = renderStatus('Patchstack setup', report({ missing: [noServerItem] }), notConnected, context, { useColor: false, concise: true });

    expect(lines).not.toContain('To do');
    expect(lines).toContain('  ℹ No server was found in this project, so Patchstack checks its packages. Blocking attacks needs a server.');
    expect(lines.some((line) => line.includes('➜ Next: connect your Patchstack account to see the details '))).toBe(true);
    expect(lines.some((line) => line.includes('turn on protection'))).toBe(false);
    expect(lines).toContain(' ✘ Publish your app');
    expect(lines).not.toContain(' ✘ Deploy to protect your live app');
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
      'The Patchstack widget now shows in your app preview. Refresh the preview if you don\'t see it.',
      '',
      "Don't forget to republish or redeploy the app so the protection rules protect your live app.",
      '',
      '---',
      '',
      '### 💬 What next? Reply with a number',
      '',
      '> 1️⃣ **Show me the vulnerabilities**',
      '>',
      '> 2️⃣ **Check that my account is connected**',
      '>',
      '> 3️⃣ **Help me put my app live**',
    ].join('\n').split('\n'));
  });

  it('makes no protection claims for an app with no server', () => {
    const text = renderSummary(report({ rules: 12, missing: [noServerItem] }), notConnected, context, { widgetOnPage: false }).join('\n');

    expect(text).not.toMatch(/protection rules|turn on protection|Restart your app/);
    expect(text).toContain('No server was found in this project');
    expect(text).toContain('⬜ Publish your app');
    expect(text).not.toContain('Deploy to protect');
    expect(text).not.toContain("Don't forget to republish");
    expect(text).not.toContain('widget now shows');
    expect(text).toContain('**Add the Patchstack widget to my app**');
    expect(text).toContain('**Help me put my app live**');
  });

  it('gives a browser-only app with nothing found one thing to do, and does not repeat the all-clear', () => {
    const clean = summary({ vulnerable: 0, outdated: 0, total: 2, severity: { high: 0, medium: 0, low: 0, unknown: 0 } });
    const lines = renderSummary(report({ checked: 2, findings: clean, missing: [noServerItem] }), notConnected, context, {
      widgetOnPage: true,
      widgetFile: 'index.html',
    });

    expect(lines).toEqual([
      '### 🛡️ Patchstack is set up',
      '',
      '**Checked 2 packages: no known vulnerabilities.**',
      '',
      '#### 👉 What to do now',
      '**Connect your Patchstack account** to see the details',
      '',
      context.claimUrl,
      '',
      '#### Progress',
      '✅ Patchstack installed',
      '⬜ Connect your Patchstack account',
      '✅ Packages checked on this computer',
      '⬜ Publish your app',
      '',
      'The Patchstack widget now shows in your app preview (in `index.html`). Refresh the preview if you don\'t see it.',
      '',
      'No server was found in this project, so Patchstack checks its packages. Blocking attacks needs a server.',
      '',
      '---',
      '',
      '### 💬 What next? Reply with a number',
      '',
      '> 1️⃣ **Check that my account is connected**',
      '>',
      '> 2️⃣ **Help me put my app live**',
    ]);
  });

  it('offers only what is still left: no connection check once connected, no go-live once live', () => {
    const done: Progress = { installed: true, connected: true, synced: true, deployed: true };
    expect(summaryReplies(report(), done, { widgetOnPage: true }).map((reply) => reply.reply)).toEqual(['Show me the vulnerabilities']);
  });

  it('lists every reply it offers in AGENT-INSTALL.md with its command, so an assistant knows what to run', () => {
    const doc = readFileSync(new URL('../AGENT-INSTALL.md', import.meta.url), 'utf8');
    const table = doc.slice(doc.indexOf('### Commands for later'), doc.indexOf('Say only what the output says.'));
    const rows = table.split('\n');
    const offered = [
      ...summaryReplies(report(), notConnected, { widgetOnPage: false }),
      ...summaryReplies(report({ findings: summary({ vulnerable: 0, severity: { high: 0, medium: 0, low: 0, unknown: 0 } }) }), notConnected, { widgetOnPage: false }),
    ];
    for (const { reply, command } of offered) {
      expect(rows.some((row) => row.includes(`"${reply}"`) && row.includes(`\`${command}\``)), reply).toBe(true);
    }
  });

  it('lists what changed in the project, one line per file', () => {
    const changed = [
      { file: 'package.json', what: 'added @patchstack/connect' },
      { file: 'index.html', what: 'the Patchstack widget, just before </body>' },
      { file: 'package.json', what: 'Patchstack steps in the install and build scripts' },
    ];
    const text = renderSummary(report({ changed }), notConnected, context, { widgetOnPage: true }).join('\n');
    expect(text).toContain(
      [
        '#### What changed in your project',
        '- `package.json`: added @patchstack/connect; Patchstack steps in the install and build scripts',
        '- `index.html`: the Patchstack widget, just before </body>',
      ].join('\n'),
    );
    expect(renderSummary(report(), notConnected, context, { widgetOnPage: true }).join('\n')).not.toContain('What changed');
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
