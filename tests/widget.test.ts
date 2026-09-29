import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCAL_BUILD_MODE,
  WIDGET_MARKER_ATTR,
  WIDGET_SCRIPT_URL,
  buildWidgetTag,
  ensureSourceWidget,
  ensureWidgetInHtml,
  findSourceShell,
  publishesPagesAsIs,
  sourceWidgetBuildMode,
} from '../src/widget.js';

const UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const UUID_B = '11111111-1111-1111-1111-111111111111';

const SHELL = `<!doctype html>
<html>
  <head><title>x</title></head>
  <body>
    <div id="app"></div>
  </body>
</html>
`;

describe('buildWidgetTag', () => {
  it('emits the one-liner CDN tag with the ownership marker', () => {
    const tag = buildWidgetTag(UUID_A);
    expect(tag).toContain(`src="${WIDGET_SCRIPT_URL}"`);
    expect(tag).toContain(`data-site-uuid="${UUID_A}"`);
    expect(tag).toContain('defer');
    expect(tag).toContain(`${WIDGET_MARKER_ATTR}="true"`);
  });
});

describe('ensureWidgetInHtml', () => {
  it('adds the managed tag immediately before </body>', () => {
    const { html, action } = ensureWidgetInHtml(SHELL, UUID_A);
    expect(action).toBe('added');
    const bodyClose = html.indexOf('</body>');
    const tagIdx = html.indexOf(buildWidgetTag(UUID_A));
    expect(tagIdx).toBeGreaterThan(-1);
    expect(tagIdx).toBeLessThan(bodyClose);
  });

  it('is idempotent — a second pass with the same UUID changes nothing', () => {
    const first = ensureWidgetInHtml(SHELL, UUID_A);
    const second = ensureWidgetInHtml(first.html, UUID_A);
    expect(second.action).toBe('unchanged');
    expect(second.html).toBe(first.html);
  });

  it('updates the managed tag in place when the UUID changes', () => {
    const first = ensureWidgetInHtml(SHELL, UUID_A);
    const second = ensureWidgetInHtml(first.html, UUID_B);
    expect(second.action).toBe('updated');
    expect(second.html).toContain(`data-site-uuid="${UUID_B}"`);
    expect(second.html).not.toContain(UUID_A);
    // still exactly one loader
    expect(second.html.split(WIDGET_SCRIPT_URL).length - 1).toBe(1);
  });

  it('adopts a manual install without touching or duplicating it', () => {
    const manual = SHELL.replace(
      '</body>',
      `<script src="${WIDGET_SCRIPT_URL}" data-site-uuid="${UUID_B}" defer></script></body>`,
    );
    const { html, action } = ensureWidgetInHtml(manual, UUID_A);
    expect(action).toBe('manual');
    expect(html).toBe(manual);
  });

  it('adopts a legacy PatchstackWidget.init() install', () => {
    const legacy = SHELL.replace(
      '</body>',
      `<script src="${WIDGET_SCRIPT_URL}"></script><script>PatchstackWidget.init({ userToken: '${UUID_B}' });</script></body>`,
    );
    const { html, action } = ensureWidgetInHtml(legacy, UUID_A);
    expect(action).toBe('manual');
    expect(html).toBe(legacy);
  });

  it('declines documents without </body>', () => {
    const fragment = '<div>partial</div>';
    const { html, action } = ensureWidgetInHtml(fragment, UUID_A);
    expect(action).toBe('no-body');
    expect(html).toBe(fragment);
  });
});

describe('findSourceShell / ensureSourceWidget', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'ps-widget-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('prefers index.html over public/index.html', () => {
    mkdirSync(path.join(cwd, 'public'));
    writeFileSync(path.join(cwd, 'public', 'index.html'), SHELL);
    writeFileSync(path.join(cwd, 'index.html'), SHELL);
    expect(findSourceShell(cwd)).toBe('index.html');
  });

  it('falls back to src/app.html (SvelteKit)', () => {
    mkdirSync(path.join(cwd, 'src'));
    writeFileSync(path.join(cwd, 'src', 'app.html'), SHELL);
    expect(findSourceShell(cwd)).toBe('src/app.html');
  });

  it('returns no-shell when there is nothing editable', () => {
    expect(findSourceShell(cwd)).toBeNull();
    expect(ensureSourceWidget(cwd, UUID_A)).toEqual({ shell: null, action: 'no-shell' });
  });

  it('writes the managed tag into the shell on disk', () => {
    writeFileSync(path.join(cwd, 'index.html'), SHELL);
    const result = ensureSourceWidget(cwd, UUID_A);
    expect(result).toEqual({ shell: 'index.html', action: 'added' });
    const written = readFileSync(path.join(cwd, 'index.html'), 'utf8');
    expect(written).toContain(buildWidgetTag(UUID_A));
  });

  it('does not rewrite the file when nothing changed', () => {
    writeFileSync(path.join(cwd, 'index.html'), SHELL);
    ensureSourceWidget(cwd, UUID_A);
    const afterFirst = readFileSync(path.join(cwd, 'index.html'), 'utf8');
    const result = ensureSourceWidget(cwd, UUID_A);
    expect(result.action).toBe('unchanged');
    expect(readFileSync(path.join(cwd, 'index.html'), 'utf8')).toBe(afterFirst);
  });
});

/**
 * A server-rendered project never produces an HTML shell, and until this existed those projects were
 * told to paste the tag themselves. The instruction was reliably missed — a hosted builder's agent
 * runs setup, reads "add this yourself", stops, and the published site carries no widget at all.
 */
describe('ensureSourceWidget on a JSX root', () => {
  let cwd: string;

  const ROOT = [
    "import { HeadContent, Outlet, Scripts } from '@tanstack/react-router';",
    '',
    'function RootComponent() {',
    '  return (',
    '    <html lang="en">',
    '      <head>',
    '        <HeadContent />',
    '      </head>',
    '      <body>',
    '        <Outlet />',
    '        <Scripts />',
    '      </body>',
    '    </html>',
    '  );',
    '}',
  ].join('\n');

  const jsxRoot = (source = ROOT): string => {
    mkdirSync(path.join(cwd, 'src', 'routes'), { recursive: true });
    writeFileSync(path.join(cwd, 'src', 'routes', '__root.tsx'), source);
    return 'src/routes/__root.tsx';
  };

  const read = (): string => readFileSync(path.join(cwd, 'src', 'routes', '__root.tsx'), 'utf8');

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'ps-widget-jsx-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('writes the tag into the root component when there is no HTML shell', () => {
    const shell = jsxRoot();
    expect(ensureSourceWidget(cwd, UUID_A, shell)).toEqual({ shell, action: 'added' });
    expect(read()).toContain(buildWidgetTag(UUID_A));
  });

  it('leaves something the compiler can still parse', () => {
    // The tag is inserted verbatim, so it has to be valid JSX as well as valid HTML: `defer` reads
    // as a boolean attribute and the data-* attributes pass through.
    ensureSourceWidget(cwd, UUID_A, jsxRoot());
    const parsed = ts.createSourceFile('__root.tsx', read(), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    expect(parsed.parseDiagnostics ?? []).toHaveLength(0);
  });

  it('anchors inside <body>, after the app it is reporting on', () => {
    ensureSourceWidget(cwd, UUID_A, jsxRoot());
    const source = read();
    expect(source.indexOf('patchstack-widget.js')).toBeGreaterThan(source.indexOf('<Outlet />'));
    expect(source.indexOf('patchstack-widget.js')).toBeLessThan(source.indexOf('</body>'));
  });

  it('is idempotent — a second scan does not stack a second tag', () => {
    const shell = jsxRoot();
    ensureSourceWidget(cwd, UUID_A, shell);
    expect(ensureSourceWidget(cwd, UUID_A, shell).action).toBe('unchanged');
    expect(read().match(/patchstack-widget\.js/g) ?? []).toHaveLength(1);
  });

  it('moves a managed tag to a new site rather than adding a second', () => {
    const shell = jsxRoot();
    ensureSourceWidget(cwd, UUID_A, shell);
    expect(ensureSourceWidget(cwd, UUID_B, shell).action).toBe('updated');
    const source = read();
    expect(source).toContain(UUID_B);
    expect(source).not.toContain(UUID_A);
  });

  it('adopts a tag somebody placed themselves', () => {
    const shell = jsxRoot(ROOT.replace('<Scripts />', '<Scripts />\n        <script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="whatever" defer></script>'));
    expect(ensureSourceWidget(cwd, UUID_A, shell).action).toBe('manual');
    expect(read()).not.toContain(UUID_A);
  });

  it('prefers a real HTML shell, which is the document actually served', () => {
    // On a stack that has both, the JSX root only renders into the shell — editing it would put the
    // tag one level further from the page than it needs to be.
    writeFileSync(path.join(cwd, 'index.html'), SHELL);
    const shell = jsxRoot();
    expect(ensureSourceWidget(cwd, UUID_A, shell).shell).toBe('index.html');
    expect(read()).not.toContain('patchstack-widget.js');
  });

  it('reports no-shell when the hinted root does not exist', () => {
    expect(ensureSourceWidget(cwd, UUID_A, 'src/routes/__root.tsx')).toEqual({
      shell: null,
      action: 'no-shell',
    });
  });
});

describe('ensureWidgetInHtml: data-build-mode', () => {
  const managedWith = (mode: string | null, uuid = UUID_A): string =>
    SHELL.replace('</body>', `  ${buildWidgetTag(uuid, mode)}\n  </body>`);

  it('writes data-build-mode="local" when asked', () => {
    const { html, action } = ensureWidgetInHtml(SHELL, UUID_A, LOCAL_BUILD_MODE);

    expect(action).toBe('added');
    expect(html).toContain(buildWidgetTag(UUID_A, 'local'));
    expect(html.match(/data-build-mode=/g)).toHaveLength(1);
  });

  it('adds it to an existing managed tag without touching its other attributes', () => {
    const tag = `<script src="${WIDGET_SCRIPT_URL}" data-site-uuid="${UUID_A}" data-position="left" defer ${WIDGET_MARKER_ATTR}="true"></script>`;
    const before = SHELL.replace('</body>', `${tag}</body>`);

    const { html, action } = ensureWidgetInHtml(before, UUID_A, LOCAL_BUILD_MODE);

    expect(action).toBe('updated');
    expect(html).toContain('data-position="left"');
    expect(html).toContain(`defer data-build-mode="local" ${WIDGET_MARKER_ATTR}="true"`);
  });

  it('is idempotent once the attribute is there', () => {
    const first = ensureWidgetInHtml(SHELL, UUID_A, LOCAL_BUILD_MODE);
    const second = ensureWidgetInHtml(first.html, UUID_A, LOCAL_BUILD_MODE);

    expect(second.action).toBe('unchanged');
    expect(second.html).toBe(first.html);
  });

  it('replaces "false" with "local"', () => {
    const { html, action } = ensureWidgetInHtml(managedWith('false'), UUID_A, LOCAL_BUILD_MODE);

    expect(action).toBe('updated');
    expect(html).toContain('data-build-mode="local"');
    expect(html).not.toContain('data-build-mode="false"');
  });

  it('replaces an unquoted false as well, without adding a second attribute', () => {
    const tag = `<script src="${WIDGET_SCRIPT_URL}" data-site-uuid="${UUID_A}" data-build-mode=false defer ${WIDGET_MARKER_ATTR}="true"></script>`;

    const { html } = ensureWidgetInHtml(SHELL.replace('</body>', `${tag}</body>`), UUID_A, LOCAL_BUILD_MODE);

    expect(html.match(/data-build-mode=/g)).toHaveLength(1);
    expect(html).toContain('data-build-mode="local"');
  });

  it('leaves any other build-mode value alone', () => {
    const before = managedWith('true');

    for (const wanted of [LOCAL_BUILD_MODE, null, undefined] as const) {
      const { html, action } = ensureWidgetInHtml(before, UUID_A, wanted);
      expect(action).toBe('unchanged');
      expect(html).toBe(before);
    }
  });

  it('removes "local" when the pages are no longer published as they are', () => {
    const { html, action } = ensureWidgetInHtml(managedWith('local'), UUID_A, null);

    expect(action).toBe('updated');
    expect(html).toContain(buildWidgetTag(UUID_A));
    expect(html).not.toContain('data-build-mode');
  });

  it('keeps "false" when asked only to remove "local"', () => {
    const before = managedWith('false');

    expect(ensureWidgetInHtml(before, UUID_A, null)).toEqual({ html: before, action: 'unchanged' });
  });

  it('leaves the attribute as found when no build mode is requested', () => {
    const before = managedWith('local');

    expect(ensureWidgetInHtml(before, UUID_A).action).toBe('unchanged');
    expect(ensureWidgetInHtml(before, UUID_B).html).toContain(buildWidgetTag(UUID_B, 'local'));
  });

  it('carries the build mode across a site change', () => {
    const { html, action } = ensureWidgetInHtml(managedWith(null), UUID_B, LOCAL_BUILD_MODE);

    expect(action).toBe('updated');
    expect(html).toContain(buildWidgetTag(UUID_B, 'local'));
  });

  it('never touches a tag it does not manage', () => {
    const manual = SHELL.replace(
      '</body>',
      `<script src="${WIDGET_SCRIPT_URL}" data-site-uuid="${UUID_A}" data-build-mode="false" defer></script></body>`,
    );

    expect(ensureWidgetInHtml(manual, UUID_A, LOCAL_BUILD_MODE)).toEqual({ html: manual, action: 'manual' });
  });
});

describe('sourceWidgetBuildMode and ensureSourceWidget on a plain HTML site', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'ps-widget-mode-'));
    writeFileSync(path.join(cwd, 'index.html'), SHELL);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const manifest = (scripts: Record<string, string> = {}): void => {
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { '@patchstack/connect': '^0.5.0' }, scripts }),
    );
  };

  const scan = (environment: 'local' | 'production' | 'sandbox' = 'local'): string => {
    ensureSourceWidget(cwd, UUID_A, null, sourceWidgetBuildMode(cwd, environment));

    return readFileSync(path.join(cwd, 'index.html'), 'utf8');
  };

  it('asks for "local" when index.html is published without a build step', () => {
    manifest({ postinstall: 'patchstack-connect scan' });

    expect(publishesPagesAsIs(cwd)).toBe(true);
    expect(sourceWidgetBuildMode(cwd, 'local')).toBe('local');
    expect(sourceWidgetBuildMode(cwd, 'production')).toBe('local');
    expect(scan()).toContain(buildWidgetTag(UUID_A, 'local'));
  });

  it('does not ask for it in a sandbox, whose preview is not a local host', () => {
    manifest();

    expect(sourceWidgetBuildMode(cwd, 'sandbox')).toBeNull();
    expect(scan('sandbox')).toContain(buildWidgetTag(UUID_A));
    expect(scan('sandbox')).not.toContain('data-build-mode');
  });

  it('takes "local" off again once a build script exists', () => {
    manifest();
    expect(scan()).toContain('data-build-mode="local"');

    manifest({ build: 'vite build' });

    expect(publishesPagesAsIs(cwd)).toBe(false);
    expect(sourceWidgetBuildMode(cwd, 'local')).toBeNull();
    expect(scan()).toContain(buildWidgetTag(UUID_A));
    expect(scan()).not.toContain('data-build-mode');
  });

  it('removes "local" in a sandbox too', () => {
    manifest();
    expect(scan()).toContain('data-build-mode="local"');

    expect(scan('sandbox')).not.toContain('data-build-mode');
  });

  it('treats an empty build script as none', () => {
    manifest({ build: '  ' });

    expect(sourceWidgetBuildMode(cwd, 'local')).toBe('local');
  });

  it('does not apply without a root index.html or a readable package.json', () => {
    expect(publishesPagesAsIs(cwd)).toBe(false);

    manifest();
    rmSync(path.join(cwd, 'index.html'));
    expect(publishesPagesAsIs(cwd)).toBe(false);
  });
});
