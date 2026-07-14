import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MARKER_ATTR,
  WIDGET_CDN_URL,
  WIDGET_MARKER_ATTR,
  buildInjectionSnippet,
  injectMarker,
} from '../src/mark-build.js';
import {
  ensureSourceWidget,
  inspectSourceWidgetPreflight,
  widgetApiBaseFromEndpoint,
} from '../src/source-widget.js';

const FIRST_UUID = '550e8400-e29b-41d4-a716-446655440000';
const SECOND_UUID = '11111111-1111-1111-1111-111111111111';
const ENDPOINT = 'https://api.patchstack.com/monitor/pulse/manifest';

describe('ensureSourceWidget', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-source-widget-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('installs immediately into a Vite/static root index and updates idempotently', async () => {
    const file = path.join(cwd, 'index.html');
    await writeFile(file, '<html>\n<body><div id="app"></div>\n</body>\n</html>\n');

    const installed = await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: { framework: null, ui: 'react', bundler: 'vite' },
    });
    expect(installed).toMatchObject({ status: 'installed', file });
    let html = await readFile(file, 'utf8');
    expect(html).toContain(WIDGET_CDN_URL);
    expect(html).toContain(`data-site-uuid="${FIRST_UUID}"`);
    expect(html).toContain(`${WIDGET_MARKER_ATTR}="true"`);
    expect(html).not.toContain('__PATCHSTACK_PROD__');

    const updated = await ensureSourceWidget({
      cwd,
      siteUuid: SECOND_UUID,
      endpoint: 'https://staging.patchstack.test/monitor/pulse/manifest',
      stack: { framework: null, ui: 'react', bundler: 'vite' },
    });
    expect(updated.status).toBe('updated');
    html = await readFile(file, 'utf8');
    expect(html).not.toContain(FIRST_UUID);
    expect(html).toContain(SECOND_UUID);
    expect(html).toContain('data-api-base="https://staging.patchstack.test"');

    const unchanged = await ensureSourceWidget({
      cwd,
      siteUuid: SECOND_UUID,
      endpoint: 'https://staging.patchstack.test/monitor/pulse/manifest',
      stack: { framework: null, ui: 'react', bundler: 'vite' },
    });
    expect(unchanged.status).toBe('unchanged');
  });

  it('uses a framework root instead of an unrelated root index for Next', async () => {
    await writeFile(path.join(cwd, 'index.html'), '<html><body>unrelated export</body></html>');
    await mkdir(path.join(cwd, 'src', 'app'), { recursive: true });
    const layout = path.join(cwd, 'src', 'app', 'layout.tsx');
    await writeFile(
      layout,
      'export default function Layout({children}) { return <html><body>{children}</body></html> }\n',
    );

    const result = await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: { framework: 'next', ui: 'react', bundler: 'webpack' },
    });
    expect(result).toMatchObject({ status: 'installed', file: layout });
    expect(await readFile(layout, 'utf8')).toContain(WIDGET_CDN_URL);
    expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).not.toContain(WIDGET_CDN_URL);
  });

  it('covers both Next App Router and Pages Router global shells', async () => {
    const appLayout = path.join(cwd, 'src', 'app', 'layout.tsx');
    const pagesDocument = path.join(cwd, 'pages', '_document.tsx');
    await mkdir(path.dirname(appLayout), { recursive: true });
    await mkdir(path.dirname(pagesDocument), { recursive: true });
    await writeFile(
      appLayout,
      'export default function Layout({children}) { return <html><body>{children}</body></html> }\n',
    );
    await writeFile(
      pagesDocument,
      'export default function Document() { return <html><body><main /></body></html> }\n',
    );

    const result = await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: { framework: 'next', ui: 'react', bundler: 'webpack' },
    });

    expect(result).toMatchObject({ status: 'installed' });
    expect(result.files).toEqual([appLayout, pagesDocument]);
    expect(await readFile(appLayout, 'utf8')).toContain(WIDGET_CDN_URL);
    expect(await readFile(pagesDocument, 'utf8')).toContain(WIDGET_CDN_URL);
  });

  it('rejects duplicate alternatives inside one Next router family', async () => {
    const srcLayout = path.join(cwd, 'src', 'app', 'layout.tsx');
    const rootLayout = path.join(cwd, 'app', 'layout.tsx');
    await mkdir(path.dirname(srcLayout), { recursive: true });
    await mkdir(path.dirname(rootLayout), { recursive: true });
    const source = '<html><body>layout</body></html>\n';
    await writeFile(srcLayout, source);
    await writeFile(rootLayout, source);

    const result = await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: { framework: 'next', ui: 'react', bundler: 'webpack' },
    });

    expect(result.status).toBe('ambiguous');
    expect(await readFile(srcLayout, 'utf8')).toBe(source);
    expect(await readFile(rootLayout, 'utf8')).toBe(source);
  });

  it('declines ambiguous generic shells instead of guessing', async () => {
    const root = path.join(cwd, 'index.html');
    const publicIndex = path.join(cwd, 'public', 'index.html');
    await mkdir(path.dirname(publicIndex), { recursive: true });
    await writeFile(root, '<html><body>root</body></html>');
    await writeFile(publicIndex, '<html><body>public</body></html>');

    const result = await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: null,
    });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
    expect(await readFile(root, 'utf8')).not.toContain(WIDGET_CDN_URL);
    expect(await readFile(publicIndex, 'utf8')).not.toContain(WIDGET_CDN_URL);
  });

  it('fails closed on a legacy dynamic install outside the selected global shell', async () => {
    await writeFile(path.join(cwd, 'index.html'), '<html><body><div id="app"></div></body></html>');
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    const app = path.join(cwd, 'src', 'App.tsx');
    await writeFile(
      app,
      `const script = document.createElement('script'); script.src = '${WIDGET_CDN_URL}';`,
    );

    const result = await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: { framework: null, ui: 'react', bundler: 'vite' },
    });
    expect(result).toEqual({
      status: 'failed',
      file: app,
      message: 'Patchstack loader or initializer is outside the selected global source shell',
    });
    expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).not.toContain(WIDGET_CDN_URL);
  });

  it('cleans up a managed duplicate while preserving a manual shell tag', async () => {
    const index = path.join(cwd, 'index.html');
    const manual = `<script src="${WIDGET_CDN_URL}" data-site-uuid="manual"></script>`;
    const managed =
      `<script src="${WIDGET_CDN_URL}" data-site-uuid="${FIRST_UUID}" defer ` +
      `${WIDGET_MARKER_ATTR}="true"></script>`;
    await writeFile(index, `<html><body>${manual}${managed}</body></html>`);

    const result = await ensureSourceWidget({
      cwd,
      siteUuid: SECOND_UUID,
      endpoint: ENDPOINT,
      stack: { framework: null, ui: 'react', bundler: 'vite' },
    });

    expect(result).toMatchObject({ status: 'updated', file: index });
    const html = await readFile(index, 'utf8');
    expect((html.match(/patchstack-widget\.js/g) ?? [])).toHaveLength(1);
    expect(html).toContain('data-site-uuid="manual"');
    expect(html).not.toContain(WIDGET_MARKER_ATTR);
  });

  it('ignores widget installation examples inside source prompts and comments', async () => {
    const index = path.join(cwd, 'index.html');
    await writeFile(index, '<html><body><div id="app"></div></body></html>');
    await mkdir(path.join(cwd, 'src', 'components'), { recursive: true });
    const instructions = path.join(cwd, 'src', 'components', 'Installer.tsx');
    const prompt = [
      'export const instructions = `',
      `<script src="${WIDGET_CDN_URL}"></script>`,
      `PatchstackWidget.init({ siteUuid: '${FIRST_UUID}' });`,
      '<Scripts />',
      '</body>',
      '`;',
      `// PatchstackWidget.init() ${WIDGET_CDN_URL}`,
      '',
    ].join('\n');
    await writeFile(instructions, prompt);

    const result = await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: { framework: null, ui: 'react', bundler: 'vite' },
    });

    expect(result).toMatchObject({ status: 'installed', file: index });
    expect(await readFile(index, 'utf8')).toContain(WIDGET_CDN_URL);
    expect(await readFile(instructions, 'utf8')).toBe(prompt);
  });

  it('installs a Remix fragment root before its one live Scripts component', async () => {
    await mkdir(path.join(cwd, 'app'), { recursive: true });
    const root = path.join(cwd, 'app', 'root.tsx');
    const source = [
      'const example = `<Scripts />`;',
      'export default function App() {',
      '  return <>',
      '    {/* <Scripts /> */}',
      '    <Outlet />',
      '    <Scripts nonce={nonce} />',
      '  </>;',
      '}',
      '',
    ].join('\n');
    await writeFile(root, source);

    const result = await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: { framework: 'remix', ui: 'react', bundler: 'vite' },
    });

    expect(result).toMatchObject({ status: 'installed', file: root });
    const updated = await readFile(root, 'utf8');
    expect(updated).toContain('const example = `<Scripts />`;');
    expect(updated.indexOf(WIDGET_CDN_URL)).toBeGreaterThan(updated.indexOf('<Outlet />'));
    expect(updated.indexOf(WIDGET_CDN_URL)).toBeLessThan(
      updated.indexOf('<Scripts nonce={nonce} />'),
    );
  });

  it('does not guess when a Remix root has multiple live Scripts anchors', async () => {
    await mkdir(path.join(cwd, 'app'), { recursive: true });
    const root = path.join(cwd, 'app', 'root.tsx');
    const source = 'export default () => <><Scripts /><Scripts /></>;\n';
    await writeFile(root, source);

    const result = await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: { framework: 'remix', ui: 'react', bundler: 'vite' },
    });

    expect(result.status).toBe('not-found');
    expect(await readFile(root, 'utf8')).toBe(source);
  });

  it('installs and updates every full-document Astro layout as one group', async () => {
    const layouts = path.join(cwd, 'src', 'layouts');
    await mkdir(path.join(layouts, 'admin'), { recursive: true });
    const main = path.join(layouts, 'Layout.astro');
    const admin = path.join(layouts, 'admin', 'Layout.astro');
    const partial = path.join(layouts, 'Partial.astro');
    const example = path.join(layouts, 'Example.astro');
    const mainSource = [
      '---',
      'const prompt = `<html><body>example only</body></html>`;',
      '---',
      '<html><body><slot /></body></html>',
      '',
    ].join('\n');
    const adminSource = '<html>\n  <body>admin\n  </body>\n</html>\n';
    const partialSource = '<section><slot /></section>\n';
    const exampleSource = '---\nconst prompt = `<html><body>x</body></html>`;\n---\n';
    await writeFile(main, mainSource);
    await writeFile(admin, adminSource);
    await writeFile(partial, partialSource);
    await writeFile(example, exampleSource);

    const installed = await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: { framework: 'astro', ui: null, bundler: 'vite' },
    });

    expect(installed.status).toBe('installed');
    expect(installed.files).toEqual([main, admin]);
    expect(await readFile(main, 'utf8')).toContain(`data-site-uuid="${FIRST_UUID}"`);
    expect(await readFile(admin, 'utf8')).toContain(`data-site-uuid="${FIRST_UUID}"`);
    expect(await readFile(partial, 'utf8')).toBe(partialSource);
    expect(await readFile(example, 'utf8')).toBe(exampleSource);

    const updated = await ensureSourceWidget({
      cwd,
      siteUuid: SECOND_UUID,
      endpoint: ENDPOINT,
      stack: { framework: 'astro', ui: null, bundler: 'vite' },
    });
    expect(updated.status).toBe('updated');
    for (const file of [main, admin]) {
      const html = await readFile(file, 'utf8');
      expect(html).toContain(SECOND_UUID);
      expect(html).not.toContain(FIRST_UUID);
      expect((html.match(new RegExp(WIDGET_MARKER_ATTR, 'g')) ?? [])).toHaveLength(1);
    }
  });

  it('preserves a manual Astro layout while installing its uncovered sibling', async () => {
    const layouts = path.join(cwd, 'src', 'layouts');
    await mkdir(layouts, { recursive: true });
    const manual = path.join(layouts, 'Manual.astro');
    const missing = path.join(layouts, 'Missing.astro');
    const manualSource =
      `<html><body><script src="${WIDGET_CDN_URL}"></script></body></html>\n`;
    await writeFile(manual, manualSource);
    await writeFile(missing, '<html><body><slot /></body></html>\n');

    const result = await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: { framework: 'astro', ui: null, bundler: 'vite' },
    });

    expect(result.status).toBe('installed');
    expect(await readFile(manual, 'utf8')).toBe(manualSource);
    expect(await readFile(missing, 'utf8')).toContain(WIDGET_MARKER_ATTR);
  });

  it('ignores unrelated nested and symlinked HTML files', async () => {
    await mkdir(path.join(cwd, 'docs'), { recursive: true });
    await writeFile(path.join(cwd, 'docs', 'index.html'), '<html><body>docs</body></html>');
    await writeFile(path.join(cwd, 'outside.html'), '<html><body>outside</body></html>');
    await symlink(path.join(cwd, 'outside.html'), path.join(cwd, 'index.html'));

    const result = await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: null,
    });
    expect(result.status).toBe('not-found');
    expect(await readFile(path.join(cwd, 'docs', 'index.html'), 'utf8')).not.toContain(
      WIDGET_CDN_URL,
    );
  });

  it('turns the source-owned tag into one production tag plus one build marker', async () => {
    const file = path.join(cwd, 'index.html');
    await writeFile(file, '<html><head></head><body>app</body></html>');
    await ensureSourceWidget({
      cwd,
      siteUuid: FIRST_UUID,
      endpoint: ENDPOINT,
      stack: null,
    });
    const source = await readFile(file, 'utf8');
    const built = injectMarker(source, buildInjectionSnippet('checksum', null, FIRST_UUID));
    expect((built.match(new RegExp(WIDGET_CDN_URL, 'g')) ?? [])).toHaveLength(1);
    expect((built.match(new RegExp(WIDGET_MARKER_ATTR, 'g')) ?? [])).toHaveLength(1);
    expect((built.match(new RegExp(MARKER_ATTR, 'g')) ?? [])).toHaveLength(1);
    expect(built.indexOf(MARKER_ATTR)).toBeLessThan(built.indexOf(WIDGET_CDN_URL));
  });
});

describe('inspectSourceWidgetPreflight', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-source-preflight-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('adopts a legacy UUID from the selected Next shell and ignores unrelated components', async () => {
    const layout = path.join(cwd, 'src', 'app', 'layout.tsx');
    await mkdir(path.dirname(layout), { recursive: true });
    await writeFile(
      layout,
      `<html><body><script src="${WIDGET_CDN_URL}"></script>` +
        `<script>PatchstackWidget.init({ userToken: '${FIRST_UUID}' });</script></body></html>`,
    );
    const unrelated = path.join(cwd, 'src', 'components', 'Example.tsx');
    await mkdir(path.dirname(unrelated), { recursive: true });
    await writeFile(
      unrelated,
      `PatchstackWidget.init({ siteUuid: '${SECOND_UUID}' });`,
    );

    const result = await inspectSourceWidgetPreflight({
      cwd,
      stack: { framework: 'next', ui: 'react', bundler: 'webpack' },
      expectedSiteUuid: FIRST_UUID,
    });

    expect(result).toMatchObject({
      status: 'configured',
      uuid: FIRST_UUID,
      uuids: [FIRST_UUID],
      files: [layout],
      hasManual: true,
      matchesExpectedUuid: true,
    });
  });

  it('makes a configured manual UUID mismatch explicit', async () => {
    const index = path.join(cwd, 'index.html');
    await writeFile(
      index,
      `<html><body><script src="${WIDGET_CDN_URL}" data-site-uuid="${FIRST_UUID}"></script></body></html>`,
    );

    const result = await inspectSourceWidgetPreflight({
      cwd,
      stack: null,
      expectedSiteUuid: SECOND_UUID,
    });
    expect(result).toMatchObject({
      status: 'configured',
      uuid: FIRST_UUID,
      hasManual: true,
      matchesExpectedUuid: false,
    });
  });

  it('reports ambiguous global shells instead of choosing one', async () => {
    const root = path.join(cwd, 'index.html');
    const publicIndex = path.join(cwd, 'public', 'index.html');
    await mkdir(path.dirname(publicIndex), { recursive: true });
    await writeFile(root, '<html><body>root</body></html>');
    await writeFile(publicIndex, '<html><body>public</body></html>');

    const result = await inspectSourceWidgetPreflight({ cwd, stack: null });
    expect(result.status).toBe('ambiguous');
    expect(result.files).toEqual([root, publicIndex]);
    expect(result.uuid).toBeNull();
  });

  it('reports grouped layout conflicts while ignoring absent sibling identity', async () => {
    const layouts = path.join(cwd, 'src', 'layouts');
    await mkdir(layouts, { recursive: true });
    await writeFile(
      path.join(layouts, 'A.astro'),
      `<html><body><script src="${WIDGET_CDN_URL}" data-site-uuid="${FIRST_UUID}"></script></body></html>`,
    );
    await writeFile(
      path.join(layouts, 'B.astro'),
      `<html><body><script src="${WIDGET_CDN_URL}" data-site-uuid="${SECOND_UUID}"></script></body></html>`,
    );
    await writeFile(path.join(layouts, 'C.astro'), '<html><body><slot /></body></html>');

    const result = await inspectSourceWidgetPreflight({
      cwd,
      stack: { framework: 'astro', ui: null, bundler: 'vite' },
    });
    expect(result).toMatchObject({
      status: 'conflict',
      uuid: null,
      uuids: [SECOND_UUID, FIRST_UUID].sort(),
    });
  });

  it('does not mistake a nested component for the selected global shell', async () => {
    const component = path.join(cwd, 'src', 'components', 'WidgetExample.tsx');
    await mkdir(path.dirname(component), { recursive: true });
    await writeFile(
      component,
      `<script src="${WIDGET_CDN_URL}" data-site-uuid="${FIRST_UUID}"></script>`,
    );

    expect(await inspectSourceWidgetPreflight({ cwd, stack: null })).toMatchObject({
      status: 'absent',
      uuid: null,
      files: [],
    });
  });
});

describe('widgetApiBaseFromEndpoint', () => {
  it('omits the production origin and propagates a custom HTTP(S) origin', () => {
    expect(widgetApiBaseFromEndpoint(ENDPOINT)).toBeNull();
    expect(
      widgetApiBaseFromEndpoint('http://localhost:8000/monitor/pulse/manifest'),
    ).toBe('http://localhost:8000');
  });

  it('rejects non-HTTP endpoints', () => {
    expect(() => widgetApiBaseFromEndpoint('file:///tmp/manifest')).toThrow('unsupported protocol');
  });
});
