import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MARKER_ATTR,
  buildInjectionSnippet,
  buildSourceMarkerSnippet,
  ensureMarkerInJsxShell,
  ensureSourceMarker,
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


describe('ensureMarkerInJsxShell', () => {
  const widgetLine =
    '      <script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="u" defer />';

  const doc = (body: string): string =>
    ['export const Root = () => (', '  <html>', '    <head>', '    </head>', '    <body>', body, '    </body>', '  </html>', ');'].join('\n');

  const syntaxErrors = (source: string): readonly ts.Diagnostic[] =>
    (ts.transpileModule(source, {
      fileName: '__root.tsx',
      reportDiagnostics: true,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );

  const multilineWidgetDoc = [
    'const patchstackConfig = { siteUuid: "00000000-0000-4000-8000-000000000000" };',
    'export const Root = () => (',
    '  <html>',
    '    <head>',
    '      <title>Example</title>',
    '    </head>',
    '    <body>',
    '      <main />',
    '      <script',
    '        src="https://cdn.patchstack.com/patchstack-widget.js"',
    '        data-site-uuid={patchstackConfig.siteUuid}',
    '        defer',
    '      />',
    '    </body>',
    '  </html>',
    ');',
  ].join('\n');

  it('inserts the marker above the widget tag, so it runs first', () => {
    const { source, action } = ensureMarkerInJsxShell(doc(widgetLine), 'tanstack-start');
    expect(action).toBe('added');
    expect(source.indexOf('__PATCHSTACK_PROD__')).toBeLessThan(source.indexOf('patchstack-widget'));
    expect(source).toContain('import.meta.env.PROD &&');
  });

  it('falls back to <head> when no widget tag is present yet', () => {
    const { source, action } = ensureMarkerInJsxShell(doc('      <div />'), 'tanstack-start');
    expect(action).toBe('added');
    expect(source.indexOf('__PATCHSTACK_PROD__')).toBeLessThan(source.indexOf('</head>'));
  });

  it('finds the end of an attributed multiline head tag', () => {
    const attributedHead = [
      'const count = 1;',
      'export const Root = () => (',
      '  <html>',
      '    <head',
      '      data-label="one > zero"',
      '      data-active={count > 0}',
      '    >',
      '      <title>Example</title>',
      '    </head>',
      '  </html>',
      ');',
    ].join('\n');

    const { source, action } = ensureMarkerInJsxShell(attributedHead, 'tanstack-start');

    expect(action).toBe('added');
    expect(source.indexOf('__PATCHSTACK_PROD__')).toBeGreaterThan(source.indexOf('\n    >'));
    expect(source.indexOf('__PATCHSTACK_PROD__')).toBeLessThan(source.indexOf('<title>'));
    expect(syntaxErrors(source)).toEqual([]);
  });

  it('does not insert outside a self-closing shell tag', () => {
    const selfClosing = [
      'export const Root = () => (',
      '  <html>',
      '    <body />',
      '  </html>',
      ');',
    ].join('\n');

    const result = ensureMarkerInJsxShell(selfClosing, 'tanstack-start');

    expect(result.action).toBe('no-anchor');
    expect(result.source).toBe(selfClosing);
  });

  it('is byte-idempotent when the opening tag has an inline child', () => {
    const inline = [
      'export const Root = () => (',
      '  <html>',
      '    <head><title>Example</title></head>',
      '  </html>',
      ');',
    ].join('\n');

    const once = ensureMarkerInJsxShell(inline, 'tanstack-start').source;
    const twice = ensureMarkerInJsxShell(once, 'tanstack-start').source;

    expect(twice).toBe(once);
    expect(syntaxErrors(twice)).toEqual([]);
  });

  it('keeps a multiline widget tag syntactically valid', () => {
    const { source, action } = ensureMarkerInJsxShell(multilineWidgetDoc, 'tanstack-start');

    expect(action).toBe('added');
    expect(source.indexOf('__PATCHSTACK_PROD__')).toBeGreaterThan(source.indexOf('<head>'));
    expect(source.indexOf('__PATCHSTACK_PROD__')).toBeLessThan(source.indexOf('<title>'));
    expect(source).toContain(
      '<script\n        src="https://cdn.patchstack.com/patchstack-widget.js"',
    );
    expect(syntaxErrors(source)).toEqual([]);
  });

  it('does not treat a widget URL in route metadata as a JSX anchor', () => {
    const tanstackRoot = [
      'export const Route = createRootRoute({',
      '  head: () => ({',
      '    scripts: [',
      '      {',
      '        src: "https://cdn.patchstack.com/patchstack-widget.js",',
      '        defer: true,',
      '      },',
      '    ],',
      '  }),',
      '  component: RootDocument,',
      '});',
      'function RootDocument() {',
      '  return (',
      '    <html>',
      '      <head>',
      '        <HeadContent />',
      '      </head>',
      '      <body />',
      '    </html>',
      '  );',
      '}',
    ].join('\n');

    const { source, action } = ensureMarkerInJsxShell(tanstackRoot, 'tanstack-start');

    expect(action).toBe('added');
    expect(source).toContain(
      'scripts: [\n      {\n        src: "https://cdn.patchstack.com/patchstack-widget.js",',
    );
    expect(source.indexOf('__PATCHSTACK_PROD__')).toBeGreaterThan(source.indexOf('<head>'));
    expect(source.indexOf('__PATCHSTACK_PROD__')).toBeLessThan(source.indexOf('<HeadContent />'));
    expect(syntaxErrors(source)).toEqual([]);
  });

  it('is idempotent — a re-run refreshes the block instead of stacking copies', () => {
    const once = ensureMarkerInJsxShell(doc(widgetLine), 'tanstack-start').source;
    const twice = ensureMarkerInJsxShell(once, 'tanstack-start').source;
    expect((twice.match(/__PATCHSTACK_PROD__/g) ?? []).length).toBe(1);
    expect((twice.match(/#region patchstack/g) ?? []).length).toBe(1);
  });

  it('repairs a managed block inserted inside multiline script attributes', () => {
    const misplacedBlock = [
      '{/* #region patchstack (managed by patchstack-connect — do not edit) */}',
      ...buildSourceMarkerSnippet('tanstack-start').split('\n'),
      '{/* #endregion patchstack */}',
    ]
      .map((line) => `        ${line}`)
      .join('\n');
    const broken = multilineWidgetDoc.replace(
      '        src="https://cdn.patchstack.com/patchstack-widget.js"',
      `${misplacedBlock}\n        src="https://cdn.patchstack.com/patchstack-widget.js"`,
    );

    expect(syntaxErrors(broken)).not.toEqual([]);

    const repaired = ensureMarkerInJsxShell(broken, 'tanstack-start');
    const rerun = ensureMarkerInJsxShell(repaired.source, 'tanstack-start');

    expect(repaired.action).toBe('added');
    expect(repaired.source.indexOf('__PATCHSTACK_PROD__')).toBeGreaterThan(
      repaired.source.indexOf('<head>'),
    );
    expect(repaired.source.indexOf('__PATCHSTACK_PROD__')).toBeLessThan(
      repaired.source.indexOf('<title>'),
    );
    expect((repaired.source.match(/#region patchstack/g) ?? []).length).toBe(1);
    expect(syntaxErrors(repaired.source)).toEqual([]);
    expect(rerun.source).toBe(repaired.source);
  });

  it('removes a misplaced managed block when no safe document anchor exists', () => {
    const source = [
      'export const head = {',
      '  scripts: [',
      '    {',
      '      src: "https://cdn.patchstack.com/patchstack-widget.js",',
      '    },',
      '  ],',
      '};',
    ].join('\n');
    const misplacedBlock = [
      '{/* #region patchstack (managed by patchstack-connect — do not edit) */}',
      ...buildSourceMarkerSnippet('tanstack-start').split('\n'),
      '{/* #endregion patchstack */}',
    ]
      .map((line) => `      ${line}`)
      .join('\n');
    const broken = source.replace(
      '      src: "https://cdn.patchstack.com/patchstack-widget.js",',
      `${misplacedBlock}\n      src: "https://cdn.patchstack.com/patchstack-widget.js",`,
    );

    const result = ensureMarkerInJsxShell(broken, 'tanstack-start');

    expect(result.action).toBe('no-anchor');
    expect(result.source).toBe(source);
  });

  it('adopts a hand-placed marker rather than adding a second one', () => {
    const hand = doc('      {import.meta.env.PROD && <script>{"window.__PATCHSTACK_PROD__=true;"}</script>}');
    const { source, action } = ensureMarkerInJsxShell(hand, 'tanstack-start');
    expect(action).toBe('manual');
    expect(source).toBe(hand);
  });

  it('reports no-anchor when the file has no JSX shell to attach to', () => {
    const { action } = ensureMarkerInJsxShell('export const x = 1;\n', 'tanstack-start');
    expect(action).toBe('no-anchor');
  });

  it('declines frameworks whose root shell is not JSX', () => {
    expect(ensureMarkerInJsxShell(doc(widgetLine), 'nuxt').action).toBe('unsupported');
    expect(ensureMarkerInJsxShell(doc(widgetLine), 'sveltekit').action).toBe('unsupported');
  });
});

describe('ensureSourceMarker', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'psmarker-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the marker into the shell so the next build compiles it in', () => {
    mkdirSync(path.join(root, 'src', 'routes'), { recursive: true });
    const shell = path.join('src', 'routes', '__root.tsx');
    writeFileSync(
      path.join(root, shell),
      'export const Root = () => (\n  <html>\n    <head>\n    </head>\n  </html>\n);\n',
    );

    const result = ensureSourceMarker(root, shell, 'tanstack-start');
    expect(result.action).toBe('added');
    expect(readFileSync(path.join(root, shell), 'utf8')).toContain('window.__PATCHSTACK_PROD__=true;');
  });

  it('leaves the file untouched when there is no anchor', () => {
    const shell = 'root.tsx';
    writeFileSync(path.join(root, shell), 'export const x = 1;\n');

    expect(ensureSourceMarker(root, shell, 'tanstack-start').action).toBe('no-anchor');
    expect(readFileSync(path.join(root, shell), 'utf8')).toBe('export const x = 1;\n');
  });

  it('persists cleanup when a stale managed block has no new anchor', () => {
    const shell = 'root.tsx';
    const clean = 'export const x = 1;\n';
    const stale = [
      '{/* #region patchstack (managed by patchstack-connect — do not edit) */}',
      buildSourceMarkerSnippet('tanstack-start'),
      '{/* #endregion patchstack */}',
      clean,
    ].join('\n');
    writeFileSync(path.join(root, shell), stale);

    expect(ensureSourceMarker(root, shell, 'tanstack-start').action).toBe('no-anchor');
    expect(readFileSync(path.join(root, shell), 'utf8')).toBe(clean);
  });
});
