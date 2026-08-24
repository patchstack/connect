import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MARKER_ATTR,
  buildInjectionSnippet,
  buildSourceMarkerSnippet,
  findHtmlFiles,
  hasJsxShell,
  injectMarker,
  productionGate,
  resolveBuildDir,
} from '../src/mark-build.js';

describe('buildInjectionSnippet', () => {
  it('always marks production and includes the fingerprint when present', () => {
    const snippet = buildInjectionSnippet('abc123def456');
    expect(snippet).toContain('window.__PATCHSTACK_PROD__=true;');
    expect(snippet).toContain('window.__PATCHSTACK_BUILD__="abc123def456";');
    expect(snippet).toContain(MARKER_ATTR);
  });

  it('omits the fingerprint when it is null', () => {
    const snippet = buildInjectionSnippet(null);
    expect(snippet).toContain('__PATCHSTACK_PROD__');
    expect(snippet).not.toContain('__PATCHSTACK_BUILD__');
  });

  it('injects the stack descriptor when one carries signal', () => {
    const snippet = buildInjectionSnippet('abc123def456', {
      framework: 'tanstack-start',
      ui: 'react',
      bundler: 'vite',
      runtime: 'cloudflare-workers',
      builder: 'lovable',
      ecosystem: 'npm',
      hostingEnvKeys: ['CF_PAGES'],
    });
    expect(snippet).toContain('window.__PATCHSTACK_STACK__=');
    expect(snippet).toContain('"builder":"lovable"');
  });

  it('omits the stack when it is empty or absent', () => {
    const empty = buildInjectionSnippet('c1', {
      framework: null,
      ui: null,
      bundler: null,
      runtime: null,
      builder: null,
      ecosystem: 'npm',
      hostingEnvKeys: [],
    });
    expect(empty).not.toContain('__PATCHSTACK_STACK__');
    expect(buildInjectionSnippet('c1')).not.toContain('__PATCHSTACK_STACK__');
  });
});

describe('injectMarker', () => {
  it('injects before </head>', () => {
    const out = injectMarker(
      '<html><head><title>x</title></head><body></body></html>',
      buildInjectionSnippet('c1'),
    );
    expect(out.indexOf(MARKER_ATTR)).toBeLessThan(out.indexOf('</head>'));
  });

  it('falls back to </body> when there is no head', () => {
    const out = injectMarker('<body>hi</body>', buildInjectionSnippet('c1'));
    expect(out.indexOf(MARKER_ATTR)).toBeLessThan(out.indexOf('</body>'));
  });

  it('appends when there is neither head nor body', () => {
    const out = injectMarker('<div>bare</div>', buildInjectionSnippet('c1'));
    expect(out).toContain(MARKER_ATTR);
  });

  it('is idempotent — re-running replaces the marker instead of stacking', () => {
    const once = injectMarker('<head></head>', buildInjectionSnippet('c1'));
    const twice = injectMarker(once, buildInjectionSnippet('c2'));
    const markerCount = (twice.match(new RegExp(MARKER_ATTR, 'g')) ?? []).length;
    expect(markerCount).toBe(1);
    expect(twice).toContain('"c2"');
    expect(twice).not.toContain('"c1"');
  });
});

describe('resolveBuildDir + findHtmlFiles', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'psmb-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('auto-detects dist/ and finds nested HTML while ignoring non-HTML', () => {
    mkdirSync(path.join(root, 'dist', 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'dist', 'index.html'), '<head></head>');
    writeFileSync(path.join(root, 'dist', 'nested', 'about.html'), '<body></body>');
    writeFileSync(path.join(root, 'dist', 'app.js'), 'console.log(1)');

    const dir = resolveBuildDir(root);
    expect(dir).toBe(path.join(root, 'dist'));

    const files = findHtmlFiles(dir!);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith('index.html'))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join('nested', 'about.html')))).toBe(true);
  });

  it('honours an explicit override directory', () => {
    mkdirSync(path.join(root, 'public'), { recursive: true });
    writeFileSync(path.join(root, 'public', 'index.html'), '<head></head>');
    expect(resolveBuildDir(root, 'public')).toBe(path.join(root, 'public'));
  });

  it('returns null when no build directory exists', () => {
    expect(resolveBuildDir(root)).toBeNull();
  });
});


describe('productionGate', () => {
  it('uses the Vite-replaced flag for bundlers that define it', () => {
    expect(productionGate('tanstack-start')).toBe('import.meta.env.PROD');
    expect(productionGate('remix')).toBe('import.meta.env.PROD');
    expect(productionGate(null)).toBe('import.meta.env.PROD');
  });

  it('falls back to NODE_ENV where import.meta.env is not defined', () => {
    expect(productionGate('next')).toContain('process.env.NODE_ENV');
    expect(productionGate('gatsby')).toContain('process.env.NODE_ENV');
  });

  it('uses the Nuxt dev flag for Nuxt', () => {
    expect(productionGate('nuxt')).toBe('!import.meta.dev');
  });
});

describe('hasJsxShell', () => {
  it('is true for React-family roots and false otherwise', () => {
    expect(hasJsxShell('tanstack-start')).toBe(true);
    expect(hasJsxShell('next')).toBe(true);
    expect(hasJsxShell('nuxt')).toBe(false);
    expect(hasJsxShell('sveltekit')).toBe(false);
    expect(hasJsxShell(null)).toBe(false);
  });
});

describe('buildSourceMarkerSnippet', () => {
  it('sets the marker the widget reads, behind the framework production gate', () => {
    const snippet = buildSourceMarkerSnippet('tanstack-start');
    expect(snippet).toContain('window.__PATCHSTACK_PROD__=true;');
    expect(snippet).toContain('import.meta.env.PROD &&');
    expect(snippet).toContain(MARKER_ATTR);
  });

  it('never emits an ungated marker, which would also hide the claim flow in dev', () => {
    for (const framework of ['tanstack-start', 'next', 'remix', 'react-router', 'gatsby']) {
      const snippet = buildSourceMarkerSnippet(framework);
      const gateIndex = snippet.indexOf(productionGate(framework));
      expect(gateIndex).toBeGreaterThanOrEqual(0);
      expect(gateIndex).toBeLessThan(snippet.indexOf('__PATCHSTACK_PROD__'));
    }
  });

  it('is an inline document script, so it beats the deferred widget tag', () => {
    // A module-level assignment would not be ordered ahead of the widget's init.
    expect(buildSourceMarkerSnippet('tanstack-start')).toContain('dangerouslySetInnerHTML');
  });
});
