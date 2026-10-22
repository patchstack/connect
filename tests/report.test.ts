import { describe, expect, it } from 'vitest';

import type { PackageSummary } from '../src/client.js';
import { readFileSync } from 'node:fs';

import { SECRET_CONFIG_FILENAME } from '../src/config.js';
import {
  BUILD_SCRIPTS_CHANGE,
  INSTALL_SCRIPT_CHANGE,
  NEXT_REPLY,
  renderNext,
  renderStatus,
  renderSummary,
  SUMMARY_AGAIN,
  SUMMARY_HEADING,
  SUMMARY_INTRO,
  type StatusReport,
} from '../src/report.js';
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

  it('keeps verified readiness visible without claiming that rules are blocking', () => {
    const confirmed = 'Rules for this app are ready (none currently apply). This does not confirm active blocking.';
    const lines = renderStatus('Patchstack setup', report({ confirmed: [confirmed], rules: 0 }), notConnected, context, { useColor: false, concise: true });

    expect(lines).toContain(` ✔ ${confirmed}`);
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

const LOGO = ['```', '████████  P A T C H S T A C K', '▄▄▄▄▀▀▀▀', '```', ''];

describe('renderSummary', () => {
  it('writes the message to pass on: findings as the heading, what to do with the full link, and the word to say next', () => {
    const lines = renderSummary(report({ rules: 12 }), notConnected, context, { widgetOnPage: true });

    expect(lines).toEqual([
      ...LOGO,
      '### 🛡️ Checked 89 packages: 5 vulnerabilities in 3 packages (highest severity: high)',
      '',
      '#### 👉 What to do now',
      '1. **Connect your Patchstack account** to see the details and turn on protection',
      `   ${context.claimUrl}`,
      '2. Restart your app to turn protection on',
      '',
      `When you've connected, say **done**.`,
      '',
      '#### What Patchstack found',
      '🔴 High **1** · 🟠 Medium **3** · 🔵 Low **1** · 12 packages outdated · 12 protection rules available',
      '',
      "**Refresh your app's preview** to see the Patchstack widget.",
      '',
      "Don't forget to republish or redeploy the app so the protection rules protect your live app.",
    ]);
  });

  it('gives a browser-only app with nothing found one path: the link, then the word to say', () => {
    const clean = summary({ vulnerable: 0, outdated: 0, total: 42, severity: { high: 0, medium: 0, low: 0, unknown: 0 } });
    const changed = [
      { file: 'package.json', what: 'added @patchstack/connect' },
      { file: 'package.json', what: BUILD_SCRIPTS_CHANGE },
      { file: SECRET_CONFIG_FILENAME, what: 'API key, ignored by git. Never commit it' },
      { file: 'index.html', what: 'the Patchstack widget' },
    ];
    const lines = renderSummary(report({ checked: 42, findings: clean, missing: [noServerItem], changed }), notConnected, context, { widgetOnPage: true });

    expect(lines).toEqual([
      ...LOGO,
      '### 🛡️ Checked 42 packages: no known vulnerabilities',
      '',
      '#### 👉 Connect your Patchstack account to see the details',
      '',
      context.claimUrl,
      '',
      `When you've connected, say **done**.`,
      '',
      "**Refresh your app's preview** to see the Patchstack widget.",
      '',
      `_Patchstack is now part of your install and build. Your API key is in \`${SECRET_CONFIG_FILENAME}\`: git ignores it, so never share it._`,
    ]);
  });

  it('makes no protection claims for an app with no server, and leaves the missing server to the dashboard', () => {
    const input = report({ rules: 12, confirmed: ['Rules for this app are ready.'], missing: [noServerItem] });
    const text = renderSummary(input, notConnected, context, { widgetOnPage: false }).join('\n');

    expect(text).not.toMatch(/protection rules|turn on protection|Restart your app/);
    expect(text).not.toContain('No server was found');
    expect(text).not.toContain("Don't forget to republish");
    expect(text).not.toContain('widget');
    expect(text).not.toContain('Rules for this app are ready');
    expect(renderStatus('Patchstack setup', input, notConnected, context, { useColor: false, concise: true }).join('\n')).not.toContain('Rules for this app are ready');
  });

  it('says only the parts of the project it changed', () => {
    const installOnly = [{ file: 'package.json', what: INSTALL_SCRIPT_CHANGE }];
    expect(renderSummary(report({ changed: installOnly }), notConnected, context, { widgetOnPage: false }).join('\n')).toContain('_Patchstack is now part of your install._');
    expect(renderSummary(report(), notConnected, context, { widgetOnPage: false }).join('\n')).not.toContain('part of your');
    expect(renderSummary(report(), notConnected, context, { widgetOnPage: false }).join('\n')).not.toContain('API key');
  });

  it('includes verified readiness and every outstanding action', () => {
    const confirmed = 'Rules for this app are ready (none currently apply). This does not confirm active blocking.';
    const missing = [
      { key: 'map-upload', text: 'Could not upload the map' },
      { key: 'map-binding', text: 'Could not link the map' },
      { key: 'map-rules', text: 'Rules are still being prepared' },
      { key: 'runtime-activation', text: 'The running app could not be checked' },
    ];
    const text = renderSummary(report({ confirmed: [confirmed], missing }), notConnected, context, { widgetOnPage: false }).join('\n');

    expect(text).toContain(confirmed);
    for (const item of missing) expect(text).toContain(item.text);
  });

  it('keeps the command that goes with a step, so the person is told how to fix it', () => {
    const devOnly = {
      key: 'dev-only-install',
      text: 'Patchstack is installed as a development tool only',
      plain: { text: 'Patchstack is installed for development only, so your live app cannot use it', hint: ['Run: npm install --save-prod @patchstack/connect'] },
    };
    const text = renderSummary(report({ missing: [devOnly] }), notConnected, context, { widgetOnPage: true }).join('\n');
    expect(text).toContain('2. Patchstack is installed for development only, so your live app cannot use it\n   `npm install --save-prod @patchstack/connect`');
  });

  it('never states a count the run did not get', () => {
    const lines = renderSummary(report({ findings: null, rules: 12 }), notConnected, context, { widgetOnPage: false });
    expect(lines[5]).toBe('### 🛡️ Checked 89 packages, now watching them');
    expect(lines[7]).toBe('12 protection rules available.');
  });

  it('ends on the word AGENT-INSTALL.md maps to next, and the doc still maps the summary for later', () => {
    const doc = readFileSync(new URL('../AGENT-INSTALL.md', import.meta.url), 'utf8');
    const table = doc.slice(doc.indexOf('### Commands for later'), doc.indexOf('Say only what the output says.')).split('\n');
    expect(table.some((row) => row.includes(`"${NEXT_REPLY}"`) && row.includes('`npx @patchstack/connect next`'))).toBe(true);
    expect(table.some((row) => row.includes(`"${SUMMARY_AGAIN}"`) && row.includes('`npx @patchstack/connect summary`'))).toBe(true);
    expect(SUMMARY_INTRO).toContain(`"${NEXT_REPLY}"`);
    expect(SUMMARY_INTRO).toContain('npx @patchstack/connect next');
  });
});

describe('renderNext', () => {
  const options = { link: context.claimUrl, goLive: ['Go live on Vercel', '', ' 1. Add your Patchstack key to Vercel'], hosts: ['Vercel', 'Netlify', 'Lovable'] };

  it('repeats the link until the account is connected', () => {
    expect(renderNext(notConnected, context, options)).toEqual([
      "### ⏳ Your Patchstack account isn't connected yet",
      '',
      context.claimUrl,
      '',
      `When you've connected, say **done**.`,
    ]);
  });

  it('moves on to going live once connected, with the steps for the host', () => {
    const lines = renderNext({ ...notConnected, connected: true }, context, options);
    expect(lines).toEqual([
      '### ✅ Your Patchstack account is connected',
      '',
      `See what Patchstack found in your dashboard: ${context.claimUrl}`,
      '',
      '#### 👉 Deploy to protect your live app',
      '',
      '```',
      ...options.goLive,
      '```',
      '',
      '_Your Patchstack dashboard shows your live app once it reports in._',
    ]);
  });

  it('asks where the app is hosted when the project does not say', () => {
    const lines = renderNext({ ...notConnected, connected: true }, context, { ...options, goLive: null });
    expect(lines[lines.length - 1]).toBe('Where is your app hosted? Say its name: Vercel, Netlify or Lovable.');
  });

  it('says publish, not protect, for an app with no server', () => {
    const lines = renderNext({ ...notConnected, connected: true }, { ...context, noServer: true }, options);
    expect(lines).toContain('#### 👉 Publish your app');
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
