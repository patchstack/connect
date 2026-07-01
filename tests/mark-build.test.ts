import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MARKER_ATTR,
  buildInjectionSnippet,
  findHtmlFiles,
  injectMarker,
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
