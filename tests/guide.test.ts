import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectGuideState,
  countRemainingSteps,
  detectPackageManager,
  findWidgetMarker,
  installCommand,
  needsSourceProductionMarker,
  renderGuideChecklist,
  widgetTagInPlace,
} from '../src/guide.js';
import { PROGRESS_STEPS } from '../src/progress.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('guide', () => {
  let cwd: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-guide-'));
    delete process.env.PATCHSTACK_SITE_UUID;
    delete process.env.PATCHSTACK_ENDPOINT;
    delete process.env.PATCHSTACK_TIMEOUT_MS;
    delete process.env.PATCHSTACK_ENVIRONMENT;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(cwd, { recursive: true, force: true });
  });

  const writeJson = (relative: string, value: unknown): void => {
    writeFileSync(path.join(cwd, relative), JSON.stringify(value, null, 2));
  };

  const writeGenericProtection = (underSrc = false): void => {
    const root = underSrc ? path.join(cwd, 'src') : cwd;
    mkdirSync(path.join(root, 'patchstack'), { recursive: true });
    writeFileSync(path.join(root, 'patchstack', 'guard.ts'), 'export const protectFetch = () => {};');
    // Imported AND called. An import on its own wraps no request, so a fixture that stopped at the import
    // would be describing a project the checklist should not call done.
    writeFileSync(
      path.join(root, 'server.ts'),
      'import { protectFetch } from "./patchstack/guard";\n' +
        'export default { fetch: protectFetch(async () => new Response("ok")) };\n',
    );
  };

  describe('detectPackageManager', () => {
    it('maps lockfiles to their package manager', () => {
      writeFileSync(path.join(cwd, 'bun.lock'), '');
      expect(detectPackageManager(cwd)).toBe('bun');
    });

    it('defaults to npm when no lockfile exists', () => {
      expect(detectPackageManager(cwd)).toBe('npm');
    });

    it('keeps a platform-native manager when npm fallback creates package-lock.json', () => {
      writeFileSync(path.join(cwd, 'bun.lock'), '');
      writeFileSync(path.join(cwd, 'package-lock.json'), '{}');
      expect(detectPackageManager(cwd)).toBe('bun');
    });

    it('prefers an explicit packageManager field over lockfile inference', () => {
      writeJson('package.json', { packageManager: 'pnpm@10.0.0' });
      writeFileSync(path.join(cwd, 'bun.lock'), '');
      expect(detectPackageManager(cwd)).toBe('pnpm');
    });
  });

  describe('collectGuideState', () => {
    it('reports a fresh project as all-todo with tailored hints', async () => {
      writeJson('package.json', {
        name: 'my-app',
        dependencies: { next: '15.0.0', react: '19.0.0', 'react-dom': '19.0.0' },
      });
      mkdirSync(path.join(cwd, 'app'));
      writeFileSync(path.join(cwd, 'app', 'layout.tsx'), 'export default function Layout() {}');
      writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), '');

      const state = await collectGuideState(cwd);

      expect(state.projectName).toBe('my-app');
      expect(state.packageManager).toBe('pnpm');
      expect(state.installed).toBeNull();
      expect(state.siteUuid).toBeNull();
      expect(state.claimUrl).toBeNull();
      expect(state.prebuildWired).toBe(false);
      expect(state.postbuildWired).toBe(false);
      expect(state.widgetInstalled).toBe(false);
      expect(state.framework).toBe('next');
      expect(state.widgetFileHint).toBe('app/layout.tsx');
    });

    it('reports a fully wired project as all-done', async () => {
      writeJson('package.json', {
        name: 'done-app',
        dependencies: { '@patchstack/connect': '^0.2.11' },
        scripts: {
          postinstall: 'patchstack-connect scan',
          prebuild: 'patchstack-connect scan && lint',
          postbuild: 'patchstack-connect mark-build',
        },
      });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      mkdirSync(path.join(cwd, 'src'));
      writeFileSync(
        path.join(cwd, 'src', 'layout.tsx'),
        '<script src="https://cdn.patchstack.com/patchstack-widget.js"></script>' +
          `<script>PatchstackWidget.init({ userToken: '${VALID_UUID}' });</script>`,
      );
      writeGenericProtection(true);

      const state = await collectGuideState(cwd);

      expect(state.installed).toEqual({ version: '^0.2.11', section: 'dependencies' });
      expect(state.siteUuid).toBe(VALID_UUID);
      expect(state.claimUrl).toContain(VALID_UUID);
      expect(state.prebuildWired).toBe(true);
      expect(state.postbuildWired).toBe(true);
      expect(state.widgetInstalled).toBe(true);
      expect(state.widgetTokenMatches).toBe(true);
      expect(state.protectionWired).toBe(true);
    });

    it('does not call a scan after another prebuild command wired', async () => {
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      writeJson('package.json', {
        scripts: {
          build: 'vite build',
          prebuild: 'patchstack-connect map --upload && patchstack-connect scan',
          postbuild: 'patchstack-connect mark-build',
        },
      });

      const state = await collectGuideState(cwd);

      expect(state.prebuildWired).toBe(false);
      expect(renderGuideChecklist(state, false)).toContain(
        '✘ Add to package.json: "prebuild": "patchstack-connect scan"',
      );
    });

    it('survives a project with no package.json', async () => {
      const state = await collectGuideState(cwd);
      expect(state.hasPackageJson).toBe(false);
      expect(state.installed).toBeNull();
    });

    it('surfaces a non-default endpoint as an override', async () => {
      writeJson('package.json', { name: 'override-app' });
      writeJson('.patchstackrc.json', { endpoint: 'http://127.0.0.1:4870/monitor/pulse/manifest' });

      const state = await collectGuideState(cwd);
      expect(state.endpointOverride).toBe('http://127.0.0.1:4870/monitor/pulse/manifest');
      expect(state.siteUuid).toBeNull();

      const output = renderGuideChecklist(state, false);
      expect(output).toContain('Endpoint override: http://127.0.0.1:4870');
    });

    it('reports no override on the default endpoint', async () => {
      writeJson('package.json', { name: 'default-app' });
      const state = await collectGuideState(cwd);
      expect(state.endpointOverride).toBeNull();
    });

    it('survives an invalid .patchstackrc.json', async () => {
      writeJson('package.json', { name: 'broken-rc' });
      writeFileSync(path.join(cwd, '.patchstackrc.json'), 'not json');
      const state = await collectGuideState(cwd);
      expect(state.siteUuid).toBeNull();
    });
  });

  describe('findWidgetMarker', () => {
    it('ignores node_modules and dot-directories', () => {
      mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
      writeFileSync(
        path.join(cwd, 'node_modules', 'index.js'),
        'patchstack-widget.js',
      );
      mkdirSync(path.join(cwd, '.cache'));
      writeFileSync(path.join(cwd, '.cache', 'page.html'), 'patchstack-widget.js');
      expect(findWidgetMarker(cwd)).toEqual({ found: false, uuidMatches: null });
    });

    it('finds the marker in nested source files', () => {
      mkdirSync(path.join(cwd, 'src', 'routes'), { recursive: true });
      writeFileSync(
        path.join(cwd, 'src', 'routes', '__root.tsx'),
        'const s = "https://cdn.patchstack.com/patchstack-widget.js";',
      );
      expect(findWidgetMarker(cwd)).toEqual({ found: true, uuidMatches: null });
    });

    it('checks the userToken against the site UUID when one is known', () => {
      writeFileSync(
        path.join(cwd, 'index.html'),
        `patchstack-widget.js userToken: '${VALID_UUID}'`,
      );
      expect(findWidgetMarker(cwd, VALID_UUID)).toEqual({ found: true, uuidMatches: true });
      expect(findWidgetMarker(cwd, '11111111-1111-1111-1111-111111111111')).toEqual({
        found: true,
        uuidMatches: false,
      });
    });
  });

  describe('renderGuideChecklist', () => {
    const wiredProject = (): void => {
      writeJson('package.json', {
        name: 'done-app',
        dependencies: { '@patchstack/connect': '0.2.11' },
        scripts: {
          postinstall: 'patchstack-connect scan',
          prebuild: 'patchstack-connect scan',
          postbuild: 'patchstack-connect mark-build',
        },
      });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      writeFileSync(path.join(cwd, 'index.html'), `patchstack-widget.js userToken: '${VALID_UUID}'`);
      writeGenericProtection();
    };

    it('prints the four progress steps in order, with the agreed wording', async () => {
      writeJson('package.json', { name: 'fresh-app' });

      const output = renderGuideChecklist(await collectGuideState(cwd), false);
      const positions = [
        ' ✘ Install the Patchstack connector',
        ' ✘ Connect project to Patchstack account',
        ' ✘ Sync and monitor in local environment',
        ' ✘ Deploy project to protect live app',
      ].map((line) => output.indexOf(line));

      expect(PROGRESS_STEPS.map(({ label }) => label)).toEqual([
        'Install the Patchstack connector',
        'Connect project to Patchstack account',
        'Sync and monitor in local environment',
        'Deploy project to protect live app',
      ]);
      expect(positions.every((position) => position > -1)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    it('prints exactly one next step', async () => {
      wiredProject();

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output.match(/Next: /g)).toHaveLength(1);
    });

    it('names the package-manager-specific install as the next step when the package is missing', async () => {
      writeJson('package.json', { name: 'bun-app', scripts: { build: 'vite build' } });
      writeFileSync(path.join(cwd, 'bun.lock'), '');

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain('Next: Install the Patchstack connector');
      expect(output).toContain(`Run: ${installCommand('bun')}\n  Then run: npx @patchstack/connect setup`);
      expect(output).not.toContain('\u001B[');
    });

    it('chains the hooks inside the build script on bun', async () => {
      writeJson('package.json', { name: 'bun-app', scripts: { build: 'vite build' } });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      writeFileSync(path.join(cwd, 'bun.lock'), '');

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain(
        '"build": "patchstack-connect scan && <existing build command> && patchstack-connect mark-build"',
      );
      expect(output).not.toContain('"prebuild"');
    });

    it('suggests prebuild/postbuild hooks on non-bun projects', async () => {
      writeJson('package.json', { name: 'npm-app', scripts: { build: 'vite build' } });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain('"prebuild": "patchstack-connect scan"');
      expect(output).toContain('"postbuild": "patchstack-connect mark-build"');
    });

    it('flags a dev-only install because the generated guard is loaded at runtime', async () => {
      writeJson('package.json', {
        name: 'dev-only-app',
        devDependencies: { '@patchstack/connect': '^0.3.19' },
      });

      const state = await collectGuideState(cwd);
      const output = renderGuideChecklist(state, false);

      expect(state.installed?.section).toBe('devDependencies');
      expect(output).toContain('✔ Install the Patchstack connector');
      expect(output).toContain('Move @patchstack/connect to dependencies');
      expect(output).toContain('the guard loads it at runtime');
    });

    it('counts a chained build script as wired (the bun pattern)', async () => {
      writeJson('package.json', {
        name: 'bun-wired-app',
        scripts: {
          build: 'patchstack-connect scan && vite build && patchstack-connect mark-build',
        },
      });
      writeFileSync(path.join(cwd, 'bun.lock'), '');

      const state = await collectGuideState(cwd);
      expect(state.prebuildWired).toBe(true);
      expect(state.postbuildWired).toBe(true);
    });

    it('substitutes the real UUID into the widget snippet once provisioned', async () => {
      writeJson('package.json', { name: 'uuid-app', dependencies: { '@patchstack/connect': '^0.5.0' } });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain(`data-site-uuid="${VALID_UUID}"`);
      expect(output).toContain('/monitor/claim?site=');
    });

    it('makes connecting the next step on a wired project, with the claim link', async () => {
      wiredProject();

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain('✔ Install the Patchstack connector');
      expect(output).toContain('✘ Connect project to Patchstack account');
      expect(output).toContain('✔ Sync and monitor in local environment');
      expect(output).toContain('Next: Connect project to Patchstack account');
      expect(output).toContain(`Open: http`);
      expect(output).toContain(`/monitor/claim?site=${VALID_UUID}`);
      expect(output).toContain('Or run: npx @patchstack/connect claim');
      // Nothing on disk says the site has an owner, so the checklist never marks it connected.
      expect(output).not.toContain('✔ Connect');
      expect(output).not.toMatch(/^ {5}✘/m);
    });

    it('moves on to the deploy once the caller knows the site is connected', async () => {
      wiredProject();

      const output = renderGuideChecklist(await collectGuideState(cwd), false, { connected: true });

      expect(output).toContain('✔ Connect project to Patchstack account');
      expect(output).toContain('Next: Deploy project to protect live app');
      expect(output).toContain('Never commit .patchstackrc.local.json');
      expect(output).toContain('PATCHSTACK_API_KEY');
      expect(output).not.toContain('/monitor/claim?site=');
    });

    it('says all done only when every step is', async () => {
      wiredProject();

      const output = renderGuideChecklist(await collectGuideState(cwd), false, {
        connected: true,
        deployed: true,
      });

      expect(output).toContain('All done.');
      expect(output).not.toContain('Next: ');
    });

    it('flags a widget whose userToken does not match the site UUID', async () => {
      writeJson('package.json', { name: 'stale-token-app' });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      writeFileSync(
        path.join(cwd, 'index.html'),
        "patchstack-widget.js userToken: '11111111-1111-1111-1111-111111111111'",
      );

      const state = await collectGuideState(cwd);
      expect(state.widgetInstalled).toBe(true);
      expect(state.widgetTokenMatches).toBe(false);

      const output = renderGuideChecklist(state, false);
      expect(output).toContain('Widget has the wrong site UUID');
      expect(output).toContain(VALID_UUID);
    });

    it('treats "widget": false as a completed widget step, and says it is off', async () => {
      writeJson('package.json', {
        name: 'optout-app',
        dependencies: { '@patchstack/connect': '0.3.6' },
        scripts: {
          postinstall: 'patchstack-connect scan',
          prebuild: 'patchstack-connect scan',
          postbuild: 'patchstack-connect mark-build',
        },
      });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID, widget: false });
      writeGenericProtection();

      const state = await collectGuideState(cwd);
      expect(state.widgetOptOut).toBe(true);
      expect(countRemainingSteps(state)).toBe(0);

      const output = renderGuideChecklist(state, false);
      expect(output).toContain('Widget is off ("widget": false in .patchstackrc.json)');
      expect(output).not.toMatch(/^ {5}✘/m);
      expect(output).not.toContain('sign in on the Patchstack widget');
    });

    it('lists no technical sub-steps before the first scan, because setup applies them', async () => {
      writeJson('package.json', { name: 'fresh-app', dependencies: { '@patchstack/connect': '^0.5.0' } });

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain('Next: Connect project to Patchstack account\n  Run: npx @patchstack/connect setup');
      expect(output).not.toContain(installCommand('npm'));
      expect(output).not.toMatch(/^ {5}✘/m);
    });

    it('drops the setup command once the site is provisioned', async () => {
      writeJson('package.json', { name: 'fresh-app', dependencies: { '@patchstack/connect': '^0.5.0' } });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).not.toContain('Run: npx @patchstack/connect setup');
    });

    it('points at the project root when package.json is missing', async () => {
      const output = renderGuideChecklist(await collectGuideState(cwd), false);
      expect(output).toContain('No package.json here');
    });

    it('names the handoff while the provisioning scan is still to run', async () => {
      // The scan is the one step here the agent cannot do by hand, so a tool that will not execute the CLI
      // stops the flow exactly there. The pointer has to name a heading that exists, or it sends the agent
      // nowhere.
      writeJson('package.json', { name: 'blocked-app', dependencies: { '@patchstack/connect': '^0.5.0' } });

      const output = renderGuideChecklist(await collectGuideState(cwd), false);
      const heading = 'When your tool will not run this CLI';

      expect(output).toMatch(/give the command to the user/);
      expect(output).toContain(heading);
      expect(readFileSync(new URL('../AGENT-INSTALL.md', import.meta.url), 'utf8')).toContain(`## ${heading}`);
    });

    it('drops the handoff once the site is provisioned', async () => {
      writeJson('package.json', { name: 'blocked-app', dependencies: { '@patchstack/connect': '^0.5.0' } });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).not.toContain('When your tool will not run this CLI');
    });

    it('gives standalone HTML a widget-only path without manufacturing an application', async () => {
      writeFileSync(path.join(cwd, 'index.html'), '<!doctype html><html><body>Example</body></html>');

      const state = await collectGuideState(cwd);
      const output = renderGuideChecklist(state, false);

      expect(state.hasPackageJson).toBe(false);
      expect(output).toContain('Plain HTML sites');
      expect(output).toContain('Do not create a Node project');
      expect(output).toContain('site UUID or widget snippet from the Patchstack dashboard');
      expect(output).toContain('no dependency scan or runtime protection');
      expect(output).not.toContain('npm install');
      expect(output).not.toContain('Finish runtime protection');
      expect(output).not.toContain('prebuild');
    });

    it('never mentions reporting a vulnerability', async () => {
      wiredProject();

      expect(renderGuideChecklist(await collectGuideState(cwd), false)).not.toMatch(/report a vulnerability/i);
    });
  });

  /**
   * The widget tag only takes effect on a page load. A preview the user already has open
   * loaded before the tag existed, so it shows nothing and reads as a failed install.
   * Nothing in a Node CLI can reload that browser, so the checklist has to say it — and
   * only when the tag is actually in the source.
   */
  describe('the preview-reload notice', () => {
    it("asks for a reload once the tag carries this project's UUID", async () => {
      writeJson('package.json', { name: 'widgeted-app', dependencies: { '@patchstack/connect': '^0.5.0' } });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      writeFileSync(path.join(cwd, 'index.html'), `patchstack-widget.js userToken: '${VALID_UUID}'`);

      const state = await collectGuideState(cwd);
      expect(widgetTagInPlace(state)).toBe(true);

      const output = renderGuideChecklist(state, false);
      // Not an unconditional "reload now": a builder that hot reloads has already done it.
      expect(output).toContain('Widget added. Reload the preview if it is not showing.');
      expect(output).toContain('Or sign in on the Patchstack widget in the preview.');
    });

    it('stays quiet while the tag is still missing', async () => {
      writeJson('package.json', { name: 'no-widget-app' });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });

      const state = await collectGuideState(cwd);
      expect(state.widgetInstalled).toBe(false);
      expect(widgetTagInPlace(state)).toBe(false);
      expect(renderGuideChecklist(state, false)).not.toContain('Reload the preview');
    });

    it("stays quiet when the tag carries some other site's UUID", async () => {
      writeJson('package.json', { name: 'stale-token-app' });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      writeFileSync(
        path.join(cwd, 'index.html'),
        "patchstack-widget.js userToken: '11111111-1111-1111-1111-111111111111'",
      );

      const state = await collectGuideState(cwd);
      expect(widgetTagInPlace(state)).toBe(false);
      expect(renderGuideChecklist(state, false)).not.toContain('Reload the preview');
    });

    it('stays quiet for a project that opted out of the widget', async () => {
      writeJson('package.json', { name: 'optout-app' });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID, widget: false });
      writeFileSync(path.join(cwd, 'index.html'), `patchstack-widget.js userToken: '${VALID_UUID}'`);

      const state = await collectGuideState(cwd);
      expect(widgetTagInPlace(state)).toBe(false);
      expect(renderGuideChecklist(state, false)).not.toContain('Reload the preview');
    });
  });

  /**
   * Everything setup writes is a source change, so the deployed site keeps serving its previous build
   * until the project is deployed again.
   */
  describe('the deploy reminder', () => {
    it('names the deploy once the site is provisioned', async () => {
      writeJson('package.json', { name: 'provisioned-app', dependencies: { '@patchstack/connect': '^0.5.0' } });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain('Already connected? Then commit, set PATCHSTACK_API_KEY on your host, and deploy.');
    });

    it('still names it when the widget is opted out, because the rest still ships', async () => {
      writeJson('package.json', { name: 'optout-app', dependencies: { '@patchstack/connect': '^0.5.0' } });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID, widget: false });

      const output = renderGuideChecklist(await collectGuideState(cwd), false, { connected: true });

      expect(output).not.toContain('Reload the preview');
      expect(output).toContain('Next: Deploy project to protect live app');
      expect(output).toContain('The live site keeps its old build until you do.');
    });

    it('stays quiet before the first scan, when nothing has been wired yet', async () => {
      writeJson('package.json', { name: 'fresh-app' });

      const state = await collectGuideState(cwd);
      expect(state.siteUuid).toBeNull();
      expect(renderGuideChecklist(state, false)).not.toContain('PATCHSTACK_API_KEY');
    });
  });

  describe('production marker on server-rendered roots', () => {
    const tanstackProject = (rootContents: string): void => {
      writeJson('package.json', {
        name: 'ssr-app',
        dependencies: { '@tanstack/react-start': '1.0.0', react: '18.0.0' },
      });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      mkdirSync(path.join(cwd, 'src', 'routes'), { recursive: true });
      writeFileSync(path.join(cwd, 'src', 'routes', '__root.tsx'), rootContents);
    };

    const widgetTag = `<script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="${VALID_UUID}"></script>`;

    it('asks for the marker when the root is code and does not have it', async () => {
      tanstackProject(`export const Root = () => <html>${widgetTag}</html>;`);
      const state = await collectGuideState(cwd);

      expect(needsSourceProductionMarker(state)).toBe(true);
      expect(state.productionMarkerWired).toBe(false);

      const output = renderGuideChecklist(state, false);
      expect(output).toContain('Add the production marker');
      expect(output).toContain('run npx @patchstack/connect scan');
      expect(output).toContain('import.meta.env.PROD &&');
      expect(output).toContain('window.__PATCHSTACK_PROD__=true;');
    });

    it('counts the missing marker as an outstanding step', async () => {
      tanstackProject(`export const Root = () => <html>${widgetTag}</html>;`);
      const withoutMarker = countRemainingSteps(await collectGuideState(cwd));

      tanstackProject(
        `export const Root = () => <html>{import.meta.env.PROD && <script dangerouslySetInnerHTML={{ __html: 'window.__PATCHSTACK_PROD__=true;' }} />}${widgetTag}</html>;`,
      );
      const withMarker = countRemainingSteps(await collectGuideState(cwd));

      expect(withoutMarker - withMarker).toBe(1);
    });

    it('reports the marker as done once the root sets it', async () => {
      tanstackProject(
        `export const Root = () => <html>{import.meta.env.PROD && <script dangerouslySetInnerHTML={{ __html: 'window.__PATCHSTACK_PROD__=true;' }} />}${widgetTag}</html>;`,
      );
      const state = await collectGuideState(cwd);

      expect(state.productionMarkerWired).toBe(true);
      expect(renderGuideChecklist(state, false)).not.toContain('Add the production marker');
    });

    it('stays silent for a plain HTML shell, where mark-build stamps the marker', async () => {
      writeJson('package.json', { name: 'spa', dependencies: { vite: '5.0.0' } });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      writeFileSync(path.join(cwd, 'index.html'), `<html><body>${widgetTag}</body></html>`);

      const state = await collectGuideState(cwd);
      expect(needsSourceProductionMarker(state)).toBe(false);
      expect(renderGuideChecklist(state, false)).not.toContain('Add the production marker');
    });
  });
});

describe('guide on a project with no request path', () => {
  let cwd: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-guide-static-'));
    delete process.env.PATCHSTACK_SITE_UUID;
    delete process.env.PATCHSTACK_ENVIRONMENT;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(cwd, { recursive: true, force: true });
  });

  it('does not count runtime protection as a step still owed', async () => {
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'eleventy-site',
        scripts: {
          build: 'eleventy',
          postinstall: 'patchstack-connect scan',
          prebuild: 'patchstack-connect scan',
          postbuild: 'patchstack-connect mark-build',
        },
        dependencies: { '@patchstack/connect': '^0.5.0' },
        devDependencies: { '@11ty/eleventy': '^3.0.0' },
      }),
    );
    writeFileSync(path.join(cwd, '.patchstackrc.json'), JSON.stringify({ siteUuid: VALID_UUID, widget: false }));

    const state = await collectGuideState(cwd);
    const rendered = renderGuideChecklist(state, false);

    expect(state.protectionApplicable).toBe(false);
    expect(state.protectionWired).toBe(false);
    expect(countRemainingSteps(state)).toBe(0);
    expect(rendered).not.toContain('Finish runtime protection');
    expect(rendered).not.toMatch(/^ {5}✘/m);
    expect(rendered).not.toContain('✔ Connect');
  });
});
