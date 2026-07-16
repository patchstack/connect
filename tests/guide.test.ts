import { mkdirSync, writeFileSync } from 'node:fs';
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

  const writeGenericProtection = (underSrc = false): void => {
    const root = underSrc ? path.join(cwd, 'src') : cwd;
    mkdirSync(path.join(root, 'patchstack'), { recursive: true });
    writeFileSync(path.join(root, 'patchstack', 'guard.ts'), 'export const protectFetch = () => {};');
    writeFileSync(
      path.join(root, 'server.ts'),
      'import { protectFetch } from "./patchstack/guard";',
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
          prebuild: 'lint && patchstack-connect scan',
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
    it('prints the package-manager-specific install command for missing installs', async () => {
      writeJson('package.json', { name: 'bun-app' });
      writeFileSync(path.join(cwd, 'bun.lock'), '');

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain(installCommand('bun'));
      expect(output).toContain('npx @patchstack/connect scan');
      expect(output).toContain('bun skips pre/post hooks');
      expect(output).toContain(
        '"build": "patchstack-connect scan && <existing build command> && patchstack-connect mark-build"',
      );
      // Consistent action labels: "Run →" for a command, "Edit … →" for a file change.
      expect(output).toContain('Run → ');
      expect(output).toContain('Edit package.json → ');
      expect(output).not.toContain('\u001B[');
    });

    it('suggests prebuild/postbuild hooks on non-bun projects', async () => {
      writeJson('package.json', { name: 'npm-app' });

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
      expect(output).toContain('Move @patchstack/connect to runtime dependencies');
      expect(output).toContain('@patchstack/connect/protect at runtime');
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
      writeJson('package.json', { name: 'uuid-app' });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain(`data-site-uuid="${VALID_UUID}"`);
      expect(output).toContain('/monitor/claim?site=');
    });

    it('celebrates a complete setup and keeps the dashboard URL visible', async () => {
      writeJson('package.json', {
        name: 'done-app',
        dependencies: { '@patchstack/connect': '0.2.11' },
        scripts: {
          prebuild: 'patchstack-connect scan',
          postbuild: 'patchstack-connect mark-build',
        },
      });
      writeJson('.patchstackrc.json', { siteUuid: VALID_UUID });
      writeFileSync(path.join(cwd, 'index.html'), `patchstack-widget.js userToken: '${VALID_UUID}'`);
      writeGenericProtection();

      const output = renderGuideChecklist(await collectGuideState(cwd), false);

      expect(output).toContain('All setup steps complete');
      expect(output).toContain('/monitor/claim?site=');
      expect(output).not.toContain('✖');
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
      expect(output).toContain("site UUID doesn't match");
      expect(output).toContain(VALID_UUID);
    });

    it('treats "widget": false as a completed widget step', async () => {
      writeJson('package.json', {
        name: 'optout-app',
        dependencies: { '@patchstack/connect': '0.3.6' },
        scripts: {
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
      expect(output).toContain('Disclosure widget disabled by config');
      expect(output).not.toContain('✖');
    });

    it('tells unprovisioned projects the first scan installs the widget', async () => {
      writeJson('package.json', { name: 'fresh-app' });

      const output = renderGuideChecklist(await collectGuideState(cwd), false);
      expect(output).toContain('the first scan does this for you');
    });

    it('points at the project root when package.json is missing', async () => {
      const output = renderGuideChecklist(await collectGuideState(cwd), false);
      expect(output).toContain('No package.json found');
    });
  });
});
