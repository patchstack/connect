import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectGuideState,
  connectorCommand,
  detectPackageManager,
  findWidgetMarker,
  installCommand,
  renderGuideChecklist,
} from '../src/guide.js';

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

  describe('detectPackageManager', () => {
    it('maps lockfiles to their package manager', () => {
      writeFileSync(path.join(cwd, 'bun.lock'), '');
      expect(detectPackageManager(cwd)).toBe('bun');
    });

    it('defaults to npm when no lockfile exists', () => {
      expect(detectPackageManager(cwd)).toBe('npm');
    });

    it('prefers package-lock.json over other lockfiles', () => {
      writeFileSync(path.join(cwd, 'yarn.lock'), '');
      writeFileSync(path.join(cwd, 'package-lock.json'), '{}');
      expect(detectPackageManager(cwd)).toBe('npm');
    });

    it('prefers package.json packageManager over stale lockfiles', () => {
      writeJson('package.json', { packageManager: 'yarn@4.9.2' });
      writeFileSync(path.join(cwd, 'package-lock.json'), '{}');
      writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), '');

      expect(detectPackageManager(cwd)).toBe('yarn');
    });

    it('falls back to lockfiles when packageManager is malformed or unsupported', () => {
      writeJson('package.json', { packageManager: 'deno@2.0.0' });
      writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), '');

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
      expect(state.widgetEnabled).toBe(true);
      expect(state.configError).toBeNull();
      expect(state.framework).toBe('next');
      expect(state.widgetFileHint).toBe('app/layout.tsx');
    });

    it('reports a fully wired project as all-done', async () => {
      writeJson('package.json', {
        name: 'done-app',
        devDependencies: { '@patchstack/connect': '^0.2.11' },
        scripts: {
          prebuild: 'lint && patchstack-connect scan',
          build: 'vite build',
          postbuild: 'patchstack-connect mark-build --strict',
        },
      });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      writeFileSync(
        path.join(cwd, 'index.html'),
        '<script src="https://cdn.patchstack.com/patchstack-widget.js" ' +
          `data-site-uuid="${VALID_UUID}" defer data-patchstack-connect-widget="true"></script>`,
      );

      const state = await collectGuideState(cwd);

      expect(state.installed).toEqual({ version: '^0.2.11', section: 'devDependencies' });
      expect(state.siteUuid).toBe(VALID_UUID);
      expect(state.claimUrl).toContain(VALID_UUID);
      expect(state.prebuildWired).toBe(true);
      expect(state.postbuildWired).toBe(true);
      expect(state.widgetInstalled).toBe(true);
      expect(state.widgetTokenMatches).toBe(true);
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
      expect(output).toContain('endpoint override in effect: http://127.0.0.1:4870');
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
      expect(state.configError).toContain('contains invalid JSON');

      const output = renderGuideChecklist(state, false);
      expect(output).toContain('Fix the invalid connector configuration before scanning');
      expect(output).toContain('contains invalid JSON');
      expect(output).not.toContain('Provision the site — run the first scan');
    });

    it('does not count a widget in an unrelated nested example as the app widget', async () => {
      writeJson('package.json', { name: 'root-app' });
      writeFileSync(path.join(cwd, 'index.html'), '<html><body>Root app</body></html>');
      mkdirSync(path.join(cwd, 'examples', 'demo'), { recursive: true });
      writeFileSync(
        path.join(cwd, 'examples', 'demo', 'index.html'),
        `<script src="patchstack-widget.js" data-site-uuid="${VALID_UUID}"></script>`,
      );

      const state = await collectGuideState(cwd);
      expect(state.widgetInstalled).toBe(false);
      expect(state.widgetTokenMatches).toBeNull();
    });

    it('does not call an initializer without a widget loader installed', async () => {
      writeJson('package.json', { name: 'initializer-only' });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      writeFileSync(
        path.join(cwd, 'index.html'),
        `<script>PatchstackWidget.init({ userToken: '${VALID_UUID}' });</script>`,
      );

      const state = await collectGuideState(cwd);
      expect(state.widgetInstalled).toBe(false);
      expect(state.widgetTokenMatches).toBeNull();
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

    it('checks the managed data-site-uuid against the site UUID when one is known', () => {
      writeFileSync(
        path.join(cwd, 'index.html'),
        `<script src="patchstack-widget.js" data-site-uuid="${VALID_UUID}" ` +
          'data-patchstack-connect-widget="true"></script>',
      );
      expect(findWidgetMarker(cwd, VALID_UUID)).toEqual({ found: true, uuidMatches: true });
      expect(findWidgetMarker(cwd, '11111111-1111-1111-1111-111111111111')).toEqual({
        found: true,
        uuidMatches: false,
      });
    });

    it('still recognises a matching UUID in the legacy userToken initialiser', () => {
      writeFileSync(
        path.join(cwd, 'index.html'),
        `patchstack-widget.js; PatchstackWidget.init({ userToken: '${VALID_UUID}' });`,
      );
      expect(findWidgetMarker(cwd, VALID_UUID)).toEqual({ found: true, uuidMatches: true });
    });
  });

  describe('renderGuideChecklist', () => {
    it.each([
      ['npm', 'npx --no-install patchstack-connect'],
      ['pnpm', 'pnpm exec patchstack-connect'],
      ['yarn', 'yarn patchstack-connect'],
      ['bun', 'bun run patchstack-connect'],
    ] as const)('uses the installed %s CLI without a registry fallback', (manager, command) => {
      expect(connectorCommand(manager)).toBe(command);
    });

    it('prints the package-manager-specific install command for missing installs', async () => {
      writeJson('package.json', { name: 'bun-app' });
      writeFileSync(path.join(cwd, 'bun.lock'), '');

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain(installCommand('bun'));
      expect(output).toContain('bun run patchstack-connect scan');
      expect(output).toContain('portability across Bun-based hosts');
      expect(output).toContain(
        '"build": "patchstack-connect scan && <existing build command> && patchstack-connect mark-build --strict"',
      );
      expect(output).not.toContain('\u001B[');
    });

    it('suggests prebuild/postbuild hooks on npm projects', async () => {
      writeJson('package.json', { name: 'npm-app' });

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain('"prebuild": "patchstack-connect scan"');
      expect(output).toContain('"postbuild": "patchstack-connect mark-build --strict"');
    });

    it('counts a chained build script as wired (the bun pattern)', async () => {
      writeJson('package.json', {
        name: 'bun-wired-app',
        scripts: {
          build:
            'patchstack-connect scan && vite build && patchstack-connect mark-build --strict',
        },
      });
      writeFileSync(path.join(cwd, 'bun.lock'), '');

      const state = await collectGuideState(cwd);
      expect(state.prebuildWired).toBe(true);
      expect(state.postbuildWired).toBe(true);
    });

    it('also recognises Bun prebuild/postbuild hooks supported by bun run', async () => {
      writeJson('package.json', {
        name: 'bun-hooks-app',
        scripts: {
          prebuild: 'patchstack-connect scan',
          build: 'vite build',
          postbuild: 'patchstack-connect mark-build --strict',
        },
      });
      writeFileSync(path.join(cwd, 'bun.lock'), '');

      const state = await collectGuideState(cwd);
      expect(state.prebuildWired).toBe(true);
      expect(state.postbuildWired).toBe(true);
    });

    it('requires mark-build --strict before declaring the lifecycle complete', async () => {
      writeJson('package.json', {
        name: 'non-strict-app',
        scripts: {
          prebuild: 'patchstack-connect scan',
          build: 'vite build',
          postbuild: 'patchstack-connect mark-build',
        },
      });

      const state = await collectGuideState(cwd);
      expect(state.prebuildWired).toBe(true);
      expect(state.postbuildWired).toBe(false);
      expect(renderGuideChecklist(state, false)).toContain(
        '"postbuild": "patchstack-connect mark-build --strict"',
      );
    });

    it('requires a static-output assertion before a hybrid-capable framework can be complete', async () => {
      writeJson('package.json', {
        name: 'next-static-app',
        dependencies: { next: '15.0.0', react: '19.0.0' },
        scripts: {
          prebuild: 'patchstack-connect scan',
          build: 'next build',
          postbuild: 'patchstack-connect mark-build --strict',
        },
      });

      let state = await collectGuideState(cwd);
      expect(state.prebuildWired).toBe(true);
      expect(state.postbuildWired).toBe(false);
      let output = renderGuideChecklist(state, false);
      expect(output).toContain('mark-build --strict --static-output');
      expect(output).toContain('do not use it for SSR or hybrid deployments');

      writeJson('package.json', {
        name: 'next-static-app',
        dependencies: { next: '15.0.0', react: '19.0.0' },
        scripts: {
          prebuild: 'patchstack-connect scan',
          build: 'next build',
          postbuild: 'patchstack-connect mark-build --strict --static-output',
        },
      });
      state = await collectGuideState(cwd);
      expect(state.postbuildWired).toBe(true);
      output = renderGuideChecklist(state, false);
      expect(output).toContain(
        'Build lifecycle wired (scan before builds, mark-build --strict --static-output after)',
      );
    });

    it('requires an explicit build chain for Yarn even when pre/post scripts exist', async () => {
      writeJson('package.json', {
        name: 'yarn-hooks-app',
        scripts: {
          prebuild: 'patchstack-connect scan',
          build: 'vite build',
          postbuild: 'patchstack-connect mark-build --strict',
        },
      });
      writeFileSync(path.join(cwd, 'yarn.lock'), '');

      const state = await collectGuideState(cwd);
      expect(state.prebuildWired).toBe(false);
      expect(state.postbuildWired).toBe(false);

      const output = renderGuideChecklist(state, false);
      expect(output).toContain('modern Yarn skips arbitrary pre/post hooks');
      expect(output).toContain(
        '"build": "patchstack-connect scan && <existing build command> && patchstack-connect mark-build --strict"',
      );
    });

    it('counts the explicit Yarn build chain as wired', async () => {
      writeJson('package.json', {
        name: 'yarn-wired-app',
        scripts: {
          build:
            'yarn patchstack-connect scan && vite build && yarn patchstack-connect mark-build --strict',
        },
      });
      writeFileSync(path.join(cwd, 'yarn.lock'), '');

      const state = await collectGuideState(cwd);
      expect(state.prebuildWired).toBe(true);
      expect(state.postbuildWired).toBe(true);
    });

    it('requires a real build command between scan and mark-build', async () => {
      writeJson('package.json', {
        name: 'no-build-app',
        scripts: {
          prebuild: 'patchstack-connect scan',
          postbuild: 'patchstack-connect mark-build --strict',
        },
      });

      const state = await collectGuideState(cwd);
      expect(state.prebuildWired).toBe(false);
      expect(state.postbuildWired).toBe(false);
    });

    it.each([
      [
        'reversed commands',
        'patchstack-connect mark-build --strict && vite build && patchstack-connect scan',
      ],
      [
        'an echoed example',
        'echo "patchstack-connect scan && vite build && patchstack-connect mark-build --strict"',
      ],
      [
        'a dry scan',
        'patchstack-connect scan --dry-run && vite build && patchstack-connect mark-build --strict',
      ],
      [
        'an echo in place of a build',
        'patchstack-connect scan && echo building && patchstack-connect mark-build --strict',
      ],
    ])('does not accept %s as a wired build', async (_label, build) => {
      writeJson('package.json', {
        name: 'unsafe-build-app',
        packageManager: 'yarn@4.9.2',
        scripts: { build },
      });

      const state = await collectGuideState(cwd);
      expect(state.prebuildWired && state.postbuildWired).toBe(false);
    });

    it('shows the automatic scan/reload flow without suggesting a manual fallback', async () => {
      writeJson('package.json', { name: 'uuid-app' });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain('npx --no-install patchstack-connect scan, then reload the app preview');
      expect(output).toContain('repair the framework global shell');
      expect(output).not.toContain(`data-site-uuid="${VALID_UUID}"`);
      expect(output).not.toContain('PatchstackWidget.init');
      expect(output).toContain('/monitor/claim?site=');
    });

    it('celebrates a complete setup and keeps the claim URL visible', async () => {
      writeJson('package.json', {
        name: 'done-app',
        devDependencies: { '@patchstack/connect': '0.2.11' },
        scripts: {
          prebuild: 'patchstack-connect scan',
          build: 'vite build',
          postbuild: 'patchstack-connect mark-build --strict',
        },
      });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      writeFileSync(
        path.join(cwd, 'index.html'),
        `<script src="patchstack-widget.js" data-site-uuid="${VALID_UUID}" ` +
          'data-patchstack-connect-widget="true"></script>',
      );

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain('All setup steps complete');
      expect(output).toContain('/monitor/claim?site=');
      expect(output).not.toContain('✖');
    });

    it('flags a widget whose configured UUID does not match the site UUID', async () => {
      writeJson('package.json', { name: 'stale-token-app' });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      writeFileSync(
        path.join(cwd, 'index.html'),
        '<script src="patchstack-widget.js" ' +
          'data-site-uuid="11111111-1111-1111-1111-111111111111"></script>',
      );

      const state = await collectGuideState(cwd);
      expect(state.widgetInstalled).toBe(true);
      expect(state.widgetTokenMatches).toBe(false);

      const output = renderGuideChecklist(state, false);
      expect(output).toContain("configured UUID doesn't match");
      expect(output).toContain('Move/remove any loader outside the true global shell');
      expect(output).not.toContain(`data-site-uuid="${VALID_UUID}"`);
      expect(output).not.toContain('PatchstackWidget.init');
    });

    it('treats an intentional widget opt-out as complete without requesting a tag', async () => {
      writeJson('package.json', {
        name: 'widget-disabled-app',
        devDependencies: { '@patchstack/connect': '0.2.11' },
        scripts: {
          prebuild: 'patchstack-connect scan',
          build: 'vite build',
          postbuild: 'patchstack-connect mark-build --strict',
        },
      });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID, widget: false });

      const state = await collectGuideState(cwd);
      expect(state.widgetEnabled).toBe(false);
      expect(state.widgetInstalled).toBe(false);

      const output = renderGuideChecklist(state, false);
      expect(output).toContain('Disclosure widget intentionally disabled ("widget": false)');
      expect(output).toContain('All setup steps complete');
      expect(output).not.toContain('Install the "Report a vulnerability" widget');
    });

    it('points at the project root when package.json is missing', async () => {
      const output = renderGuideChecklist(await collectGuideState(cwd), false);
      expect(output).toContain('No package.json found');
    });
  });
});
