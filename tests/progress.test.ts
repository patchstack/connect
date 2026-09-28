import { describe, expect, it } from 'vitest';

import { nextProgressStep, nextStepLines, renderProgress, type NextStepContext } from '../src/progress.js';

const context: NextStepContext = {
  installCommand: 'npm install --save @patchstack/connect',
  siteUuid: '550e8400-e29b-41d4-a716-446655440000',
  claimUrl: 'https://app.example.com/monitor/claim?site=550e8400-e29b-41d4-a716-446655440000',
  widgetInPlace: false,
};

describe('progress checklist', () => {
  it('picks the first step not done', () => {
    expect(nextProgressStep({ installed: false, connected: true, synced: true, deployed: true })).toBe('installed');
    expect(nextProgressStep({ installed: true, connected: false, synced: true, deployed: false })).toBe('connected');
    expect(nextProgressStep({ installed: true, connected: true, synced: false, deployed: false })).toBe('synced');
    expect(nextProgressStep({ installed: true, connected: true, synced: true, deployed: true })).toBeNull();
  });

  it('uses ✔ for done and ✘ for not yet', () => {
    const lines = renderProgress({ installed: true, connected: false, synced: true, deployed: false }, context, {
      useColor: false,
    });

    expect(lines.slice(0, 4)).toEqual([
      ' ✔ Install the Patchstack connector',
      ' ✘ Connect project to Patchstack account',
      ' ✔ Sync and monitor in local environment',
      ' ✘ Deploy project to protect live app',
    ]);
  });

  it('gives the claim link and command for connecting', () => {
    expect(nextStepLines('connected', context)).toEqual([
      `Open: ${context.claimUrl}`,
      'Or run: npx @patchstack/connect claim',
      'Already connected? Then commit, set PATCHSTACK_API_KEY on your host, and deploy.',
    ]);
  });

  it('does not point a production run at a deploy it just made', () => {
    const lines = nextStepLines('connected', context, { installed: true, connected: false, synced: true, deployed: true });

    expect(lines.join('\n')).not.toContain('deploy');
  });

  it('sends a project with no site yet to setup', () => {
    expect(nextStepLines('connected', { ...context, siteUuid: null, claimUrl: null })[0]).toBe(
      'Run: npx @patchstack/connect setup',
    );
  });

  it('prints details under their step', () => {
    const lines = renderProgress({ installed: true, connected: false, synced: false, deployed: false }, context, {
      useColor: false,
      details: { synced: ['✘ Add to package.json: "postinstall": "patchstack-connect scan"'] },
    });

    expect(lines.indexOf('     ✘ Add to package.json: "postinstall": "patchstack-connect scan"')).toBe(
      lines.indexOf(' ✘ Sync and monitor in local environment') + 1,
    );
  });
});
