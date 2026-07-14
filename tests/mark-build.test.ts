import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MARKER_ATTR,
  WIDGET_CDN_URL,
  WIDGET_MARKER_ATTR,
  buildInjectionSnippet,
  buildWidgetTag,
  findHtmlFiles,
  hasWidgetScript,
  injectMarker,
  injectSourceWidget,
  inspectSourceWidgetIdentity,
  resolveBuildDir,
  verifyBuildHtml,
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

  it('adds the auto-initialising CDN widget when a site UUID is present', () => {
    const snippet = buildInjectionSnippet('c1', null, '550e8400-e29b-41d4-a716-446655440000');
    expect(snippet).toContain(`src="${WIDGET_CDN_URL}"`);
    expect(snippet).toContain('data-site-uuid="550e8400-e29b-41d4-a716-446655440000"');
    expect(snippet).toContain('data-production="true"');
    expect(snippet).toContain(' defer ');
    expect(snippet).toContain(WIDGET_MARKER_ATTR);
    expect(snippet.indexOf(MARKER_ATTR)).toBeLessThan(snippet.indexOf(WIDGET_MARKER_ATTR));
  });

  it('omits the widget when no site UUID is available', () => {
    const snippet = buildInjectionSnippet('c1', null, null);
    expect(snippet).not.toContain(WIDGET_CDN_URL);
    expect(snippet).not.toContain(WIDGET_MARKER_ATTR);
  });

  it('passes a non-production API origin to the widget', () => {
    const snippet = buildInjectionSnippet(
      'c1',
      null,
      '550e8400-e29b-41d4-a716-446655440000',
      'https://staging-api.patchstack.test',
    );
    expect(snippet).toContain('data-api-base="https://staging-api.patchstack.test"');
  });

  it('escapes the site UUID before placing it in an HTML attribute', () => {
    const snippet = buildInjectionSnippet('c1', null, 'uuid"<&');
    expect(snippet).toContain('data-site-uuid="uuid&quot;&lt;&amp;"');
  });

  it('serializes hostile build metadata without terminating the inline script', () => {
    const hostile = '</script><script>window.pwned=true</script>\u2028\u2029';
    const snippet = buildInjectionSnippet(hostile, {
      framework: null,
      ui: null,
      bundler: null,
      runtime: null,
      builder: hostile,
      ecosystem: 'npm',
      hostingEnvKeys: [],
    });

    expect(snippet).not.toContain('</script><script>');
    expect(snippet).not.toContain('\u2028');
    expect(snippet).not.toContain('\u2029');
    expect(snippet).toContain('\\u003c/script\\u003e');
    expect(snippet).toContain('\\u2028\\u2029');
    expect(snippet.match(/<\/script>/g)).toHaveLength(1);
  });

  it('keeps production mode off source-preview widget tags by default', () => {
    expect(buildWidgetTag('550e8400-e29b-41d4-a716-446655440000')).not.toContain(
      'data-production',
    );
  });
});

describe('hasWidgetScript', () => {
  it('recognises rolling, immutable, and locally hosted widget bundles', () => {
    expect(hasWidgetScript(`<script src="${WIDGET_CDN_URL}"></script>`)).toBe(true);
    expect(
      hasWidgetScript(
        '<script defer src="https://cdn.patchstack.com/patchstack-widget.f7e9d8a.js"></script>',
      ),
    ).toBe(true);
    expect(hasWidgetScript("<script src='/assets/patchstack-widget.js?v=1'></script>")).toBe(true);
  });

  it('ignores unrelated scripts', () => {
    expect(hasWidgetScript('<script src="/assets/app.js"></script>')).toBe(false);
    expect(hasWidgetScript('<script data-src="/assets/patchstack-widget.js"></script>')).toBe(false);
    expect(
      hasWidgetScript('<script data-note=" src=\'/assets/patchstack-widget.js\'"></script>'),
    ).toBe(false);
    expect(
      hasWidgetScript('<!-- <script src="/assets/patchstack-widget.js"></script> -->'),
    ).toBe(false);
    expect(
      hasWidgetScript(
        '<template><script src="/assets/patchstack-widget.js"></script></template>',
      ),
    ).toBe(false);
    expect(
      hasWidgetScript(
        '<noscript><script src="/assets/patchstack-widget.js"></script></noscript>',
      ),
    ).toBe(false);
    expect(
      hasWidgetScript('<script type="text/plain" src="/assets/patchstack-widget.js"></script>'),
    ).toBe(false);
  });
});

describe('inspectSourceWidgetIdentity', () => {
  const firstUuid = '550e8400-e29b-41d4-a716-446655440000';
  const secondUuid = '11111111-1111-1111-1111-111111111111';

  it('reads a configured manual or managed CDN tag', () => {
    const manual = inspectSourceWidgetIdentity(
      `<Script src="${WIDGET_CDN_URL}" data-site-uuid="${firstUuid}" />`,
    );
    expect(manual).toMatchObject({
      status: 'configured',
      uuid: firstUuid,
      uuids: [firstUuid],
      hasManual: true,
      hasManaged: false,
    });

    const managed = inspectSourceWidgetIdentity(buildWidgetTag(secondUuid));
    expect(managed).toMatchObject({
      status: 'configured',
      uuid: secondUuid,
      hasManual: false,
      hasManaged: true,
    });

    const alias = inspectSourceWidgetIdentity(
      `<script src="${WIDGET_CDN_URL}" data-user-token="${firstUuid}"></script>`,
    );
    expect(alias).toMatchObject({
      status: 'configured',
      uuid: firstUuid,
      uuids: [firstUuid],
    });
  });

  it('combines a bare legacy loader with static userToken or siteUuid init', () => {
    for (const key of ['userToken', 'siteUuid']) {
      const source =
        `<script src="${WIDGET_CDN_URL}"></script>` +
        `<script>PatchstackWidget.init({ ${key}: '${firstUuid}' });</script>`;
      const result = inspectSourceWidgetIdentity(source);
      expect(result.status).toBe('configured');
      expect(result.uuid).toBe(firstUuid);
      expect(result.occurrences).toHaveLength(2);
    }
  });

  it('distinguishes unconfigured, dynamic, invalid, and conflicting identity', () => {
    expect(
      inspectSourceWidgetIdentity(`<script src="${WIDGET_CDN_URL}"></script>`).status,
    ).toBe('unconfigured');
    expect(
      inspectSourceWidgetIdentity(
        `<script src="${WIDGET_CDN_URL}" data-site-uuid={siteUuid}></script>`,
      ).status,
    ).toBe('dynamic');
    expect(
      inspectSourceWidgetIdentity(
        `<script src="${WIDGET_CDN_URL}" data-site-uuid="not-a-uuid"></script>`,
      ),
    ).toMatchObject({ status: 'invalid', uuid: null });

    const conflict = inspectSourceWidgetIdentity(
      `<script src="${WIDGET_CDN_URL}" data-site-uuid="${firstUuid}"></script>` +
        `<script>PatchstackWidget.init({ userToken: '${secondUuid}' });</script>`,
    );
    expect(conflict).toMatchObject({
      status: 'conflict',
      uuid: null,
      uuids: [secondUuid, firstUuid].sort(),
    });
  });

  it('treats dynamic init configuration conservatively and ignores examples', () => {
    expect(
      inspectSourceWidgetIdentity('PatchstackWidget.init({ siteUuid });').status,
    ).toBe('dynamic');
    expect(
      inspectSourceWidgetIdentity([
        `const prompt = \`<script src="${WIDGET_CDN_URL}" data-site-uuid="${firstUuid}"></script>\`;`,
        `// PatchstackWidget.init({ userToken: '${firstUuid}' });`,
        `<template><script src="${WIDGET_CDN_URL}"></script></template>`,
        `<script type="text/plain" src="${WIDGET_CDN_URL}">`,
        `PatchstackWidget.init({ siteUuid: '${firstUuid}' });</script>`,
      ].join('\n')).status,
    ).toBe('absent');
  });
});

describe('injectSourceWidget', () => {
  const firstUuid = '550e8400-e29b-41d4-a716-446655440000';
  const secondUuid = '11111111-1111-1111-1111-111111111111';

  it('inserts a managed widget before body close for immediate preview', () => {
    const result = injectSourceWidget('<html>\n  <body>app\n  </body>\n</html>\n', firstUuid);
    expect(result.status).toBe('inserted');
    expect(result.html).toContain(buildWidgetTag(firstUuid));
    expect(result.html.indexOf(WIDGET_CDN_URL)).toBeLessThan(result.html.indexOf('</body>'));
    expect(result.html).not.toContain(MARKER_ATTR);
  });

  it('updates a connector-managed tag in place and is byte-stable afterward', () => {
    const first = injectSourceWidget('<body></body>', firstUuid);
    const updated = injectSourceWidget(first.html, secondUuid, 'https://staging.example.test');
    expect(updated.status).toBe('updated');
    expect(updated.html).not.toContain(firstUuid);
    expect(updated.html).toContain(secondUuid);
    expect(updated.html).toContain('data-api-base="https://staging.example.test"');

    const unchanged = injectSourceWidget(
      updated.html,
      secondUuid,
      'https://staging.example.test',
    );
    expect(unchanged.status).toBe('unchanged');
    expect(unchanged.html).toBe(updated.html);
  });

  it('preserves an existing manual or legacy widget instead of duplicating it', () => {
    const manual =
      `<body><script src="${WIDGET_CDN_URL}"></script>` +
      `<script>PatchstackWidget.init({ userToken: '${firstUuid}' });</script></body>`;
    const result = injectSourceWidget(manual, secondUuid);
    expect(result.status).toBe('existing-manual');
    expect(result.html).toBe(manual);
    expect((result.html.match(/patchstack-widget\.js/g) ?? [])).toHaveLength(1);
  });

  it('removes a stale managed duplicate when a manual source tag is present', () => {
    const manual = `<script src="${WIDGET_CDN_URL}" data-site-uuid="manual"></script>`;
    const managed = buildWidgetTag(firstUuid);
    const result = injectSourceWidget(`<html><body>${manual}${managed}</body></html>`, secondUuid);

    expect(result.status).toBe('updated');
    expect((result.html.match(/patchstack-widget\.js/g) ?? [])).toHaveLength(1);
    expect(result.html).toContain('data-site-uuid="manual"');
    expect(result.html).not.toContain(WIDGET_MARKER_ATTR);
    expect(result.html).not.toContain(secondUuid);
  });

  it('preserves an existing Next Script component', () => {
    const manual =
      `<html><body><Script src="${WIDGET_CDN_URL}" ` +
      `data-site-uuid="${firstUuid}" strategy="afterInteractive" /></body></html>`;
    expect(injectSourceWidget(manual, secondUuid)).toEqual({
      html: manual,
      status: 'existing-manual',
    });
  });

  it('ignores commented body closers and preserves CRLF formatting', () => {
    const source = '<html>\r\n  {/* </body> */}\r\n  <body>\r\n  </body>\r\n</html>\r\n';
    const result = injectSourceWidget(source, firstUuid);
    expect(result.status).toBe('inserted');
    expect(result.html).toContain(`${buildWidgetTag(firstUuid)}\r\n  </body>`);
    expect(result.html.indexOf(WIDGET_CDN_URL)).toBeGreaterThan(result.html.indexOf('<body>'));
  });

  it('anchors to live structure instead of body examples in code and inert markup', () => {
    const source = [
      'const quoted = "</body>";',
      'const template = `</body>`;',
      '// </body>',
      '/* </body> */',
      "<script>const inside = '</body>';</script>",
      '<template></body></template>',
      '<textarea></body></textarea>',
      '<noscript></body></noscript>',
      '<html><body>live</body></html>',
    ].join('\n');

    const result = injectSourceWidget(source, firstUuid);
    expect(result.status).toBe('inserted');
    expect(result.html.slice(0, result.html.indexOf('<html>'))).toBe(
      source.slice(0, source.indexOf('<html>')),
    );
    expect(result.html.indexOf(WIDGET_CDN_URL)).toBeGreaterThan(result.html.indexOf('live'));
    expect(result.html.indexOf(WIDGET_CDN_URL)).toBeLessThan(result.html.lastIndexOf('</body>'));
  });

  it('updates only a live managed tag and leaves a prompt example byte-identical', () => {
    const prompt =
      '`<script data-patchstack-connect-widget="true" ' +
      `src="${WIDGET_CDN_URL}" data-site-uuid="prompt"></script>` +
      '`';
    const live = buildWidgetTag(firstUuid);
    const source = `const prompt = ${prompt};\n<html><body>${live}</body></html>`;

    const result = injectSourceWidget(source, secondUuid);
    expect(result.status).toBe('updated');
    expect(result.html).toContain(`const prompt = ${prompt};`);
    expect(result.html).toContain(`data-site-uuid="${secondUuid}"`);
    expect((result.html.match(new RegExp(secondUuid, 'g')) ?? [])).toHaveLength(1);
  });

  it('supports one live Remix Scripts anchor while ignoring examples', () => {
    const source = [
      'const prompt = `<Scripts />`;',
      'export default () => <>',
      '  {/* <Scripts /> */}',
      '  <Outlet />',
      '  <Scripts />',
      '</>;',
    ].join('\n');
    const result = injectSourceWidget(source, firstUuid, null, {
      anchor: 'remix-scripts',
    });
    expect(result.status).toBe('inserted');
    expect(result.html.indexOf(WIDGET_CDN_URL)).toBeGreaterThan(result.html.indexOf('<Outlet />'));
    expect(result.html.indexOf(WIDGET_CDN_URL)).toBeLessThan(result.html.lastIndexOf('<Scripts />'));

    const ambiguous = '<><Scripts /><Scripts /></>';
    expect(injectSourceWidget(ambiguous, firstUuid, null, { anchor: 'remix-scripts' })).toEqual({
      html: ambiguous,
      status: 'unsupported',
    });
  });

  it('declines fragments without a safe document closing tag', () => {
    const html = '<div>component only</div>';
    expect(injectSourceWidget(html, firstUuid)).toEqual({
      html,
      status: 'unsupported',
    });
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
    const out = injectMarker('<html><body>hi</body></html>', buildInjectionSnippet('c1'));
    expect(out).toContain(MARKER_ATTR);
    expect(out.indexOf(MARKER_ATTR)).toBeLessThan(out.indexOf('</body>'));
  });

  it('leaves an HTML fragment byte-for-byte unchanged', () => {
    const fragment = '<div>bare</div>';
    expect(injectMarker(fragment, buildInjectionSnippet('c1'))).toBe(fragment);
  });

  it('ignores false closers in raw, inert, and commented HTML content', () => {
    const html = [
      '<html><head>',
      '<script>const example = "</head>";</script>',
      '<style>.example::after { content: "</head>"; }</style>',
      '<!-- </head> -->',
      '<template></head></template>',
      '<textarea></head></textarea>',
      '<noscript></head></noscript>',
      '</head><body></body></html>',
    ].join('');
    const out = injectMarker(html, buildInjectionSnippet('c1'));
    expect(out).toContain('const example = "</head>";');
    expect(out.indexOf(MARKER_ATTR)).toBeGreaterThan(out.indexOf('</noscript>'));
    expect(out.indexOf(MARKER_ATTR)).toBeLessThan(out.lastIndexOf('</head>'));
  });

  it('does not mutate partial head/body files or component fragments', () => {
    for (const fragment of [
      '<head><title>partial</title></head>',
      '<body>partial</body>',
      '<div id="astro-fragment">partial</div>',
    ]) {
      expect(injectMarker(fragment, buildInjectionSnippet('c1'))).toBe(fragment);
    }
  });

  it('is idempotent — re-running replaces the marker instead of stacking', () => {
    const once = injectMarker(
      '<html><head></head><body></body></html>',
      buildInjectionSnippet('c1', null, '550e8400-e29b-41d4-a716-446655440000'),
    );
    const twice = injectMarker(
      once,
      buildInjectionSnippet('c2', null, '11111111-1111-1111-1111-111111111111'),
    );
    const markerCount = (twice.match(new RegExp(MARKER_ATTR, 'g')) ?? []).length;
    const widgetMarkerCount = (twice.match(new RegExp(WIDGET_MARKER_ATTR, 'g')) ?? []).length;
    expect(markerCount).toBe(1);
    expect(widgetMarkerCount).toBe(1);
    expect(twice).toContain('"c2"');
    expect(twice).not.toContain('"c1"');
    expect(twice).toContain('data-site-uuid="11111111-1111-1111-1111-111111111111"');
    expect(twice).not.toContain('550e8400-e29b-41d4-a716-446655440000');
  });

  it('is byte-for-byte stable when rerun with the same values', () => {
    const snippet = buildInjectionSnippet(
      'c1',
      null,
      '550e8400-e29b-41d4-a716-446655440000',
    );
    const once = injectMarker('<html>\n<head>\n</head>\n<body></body>\n</html>\n', snippet);
    expect(injectMarker(once, snippet)).toBe(once);
  });

  it('preserves a manual widget and does not add a connector-managed duplicate', () => {
    const manual =
      `<html><head><script src="${WIDGET_CDN_URL}" ` +
      'data-site-uuid="550e8400-e29b-41d4-a716-446655440000" defer></script></head>' +
      '<body></body></html>';
    const out = injectMarker(
      manual,
      buildInjectionSnippet('c1', null, '11111111-1111-1111-1111-111111111111'),
    );

    expect((out.match(/patchstack-widget\.js/g) ?? [])).toHaveLength(1);
    expect(out).toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(out).not.toContain(WIDGET_MARKER_ATTR);
    expect(out).toContain(MARKER_ATTR);
    expect(out.indexOf(MARKER_ATTR)).toBeLessThan(out.indexOf(WIDGET_CDN_URL));
  });

  it('preserves a compiled managed widget when the replacement snippet has no UUID', () => {
    const managed = buildWidgetTag('550e8400-e29b-41d4-a716-446655440000');
    const html = `<html><head></head><body>${managed}</body></html>`;

    const preserved = injectMarker(html, buildInjectionSnippet('c1'));
    expect(preserved).toContain(managed);
    expect(preserved).toContain(MARKER_ATTR);

    const optedOut = injectMarker(html, buildInjectionSnippet('c1'), {
      removeManagedWidget: true,
    });
    expect(optedOut).not.toContain(WIDGET_MARKER_ATTR);
  });

  it('does not remove unrelated scripts that mention a marker in an attribute value', () => {
    const unrelated = '<script data-testid="data-patchstack-build">window.keepMe=true;</script>';
    const out = injectMarker(
      `<html><head>${unrelated}</head><body></body></html>`,
      buildInjectionSnippet('c1', null, '550e8400-e29b-41d4-a716-446655440000'),
    );
    expect(out).toContain(unrelated);
  });

  it('does not remove marker-looking scripts inside inert template content', () => {
    const template =
      '<template><script data-patchstack-build>window.example=true;</script></template>';
    const out = injectMarker(
      `<html><head>${template}</head><body></body></html>`,
      buildInjectionSnippet('c1', null, '550e8400-e29b-41d4-a716-446655440000'),
    );
    expect(out).toContain(template);
    expect(out).toContain(WIDGET_MARKER_ATTR);
  });

  it('does not treat script-like CSS content as a managed marker or widget', () => {
    const style =
      `<style>.example::after { content: '<script ${MARKER_ATTR}>' + ` +
      `'${WIDGET_CDN_URL}</script>'; }</style>`;
    const out = injectMarker(
      `<html><head>${style}</head><body></body></html>`,
      buildInjectionSnippet('c1', null, '550e8400-e29b-41d4-a716-446655440000'),
    );
    expect(out).toContain(style);
    expect(out).toContain(WIDGET_MARKER_ATTR);
  });

  it('ignores a commented-out widget and injects a live managed tag', () => {
    const commented = `<!-- <script src="${WIDGET_CDN_URL}"></script> -->`;
    const out = injectMarker(
      `<html><head>${commented}</head><body></body></html>`,
      buildInjectionSnippet('c1', null, '550e8400-e29b-41d4-a716-446655440000'),
    );
    expect(out).toContain(commented);
    expect(out).toContain(WIDGET_MARKER_ATTR);
    expect(hasWidgetScript(out)).toBe(true);
  });
});

describe('verifyBuildHtml', () => {
  const expectedUuid = '550e8400-e29b-41d4-a716-446655440000';
  const wrongUuid = '11111111-1111-1111-1111-111111111111';
  const document = (head: string): string =>
    `<html><head>${head}</head><body><main>app</main></body></html>`;

  it('accepts exactly one generated production marker and matching managed widget', () => {
    const html = injectMarker(document(''), buildInjectionSnippet('c1', null, expectedUuid));
    expect(verifyBuildHtml(html, expectedUuid)).toMatchObject({
      ok: true,
      issues: [],
      isFullDocument: true,
      productionMarkerCount: 1,
      productionFlagCount: 1,
      widgetLoaderCount: 1,
      widgetUuid: expectedUuid,
    });
  });

  it('rejects a manual widget with a missing or wrong UUID', () => {
    const missing = injectMarker(
      document(`<script src="${WIDGET_CDN_URL}"></script>`),
      buildInjectionSnippet('c1', null, expectedUuid),
    );
    expect(verifyBuildHtml(missing, expectedUuid).issues).toContain('widget-identity-missing');

    const wrong = injectMarker(
      document(
        `<script src="${WIDGET_CDN_URL}" data-site-uuid="${wrongUuid}"></script>`,
      ),
      buildInjectionSnippet('c1', null, expectedUuid),
    );
    expect(verifyBuildHtml(wrong, expectedUuid)).toMatchObject({
      ok: false,
      widgetUuid: wrongUuid,
      issues: ['widget-uuid-mismatch'],
    });
  });

  it('accepts one matching synchronous legacy initializer and rejects ambiguity', () => {
    const loader = `<script src="${WIDGET_CDN_URL}"></script>`;
    const init = `<script>PatchstackWidget.init({ userToken: '${expectedUuid}' });</script>`;
    const legacy = injectMarker(
      document(loader + init),
      buildInjectionSnippet('c1', null, expectedUuid),
    );
    expect(verifyBuildHtml(legacy, expectedUuid).ok).toBe(true);

    const ambiguous = injectMarker(
      document(loader + init + init),
      buildInjectionSnippet('c1', null, expectedUuid),
    );
    expect(verifyBuildHtml(ambiguous, expectedUuid).issues).toContain(
      'widget-identity-ambiguous',
    );

    const displayedCode = injectMarker(
      document(loader + `PatchstackWidget.init({ userToken: '${expectedUuid}' });`),
      buildInjectionSnippet('c1', null, expectedUuid),
    );
    expect(verifyBuildHtml(displayedCode, expectedUuid).issues).toContain(
      'widget-identity-missing',
    );
  });

  it('requires production mode on a connector-managed output widget', () => {
    const html = document(buildInjectionSnippet('c1') + buildWidgetTag(expectedUuid));
    expect(verifyBuildHtml(html, expectedUuid).issues).toContain(
      'widget-production-attribute-invalid',
    );
  });

  it('reports fragments and duplicate production markers', () => {
    expect(verifyBuildHtml('<div>fragment</div>', expectedUuid).issues).toContain(
      'not-full-document',
    );

    const marker = buildInjectionSnippet('c1');
    const duplicate = document(marker + marker + buildWidgetTag(expectedUuid, null, {
      production: true,
    }));
    expect(verifyBuildHtml(duplicate, expectedUuid).issues).toContain(
      'production-marker-duplicate',
    );
  });

  it('strictly verifies the widget-supported data-user-token alias', () => {
    const aliasTag =
      `<script src="${WIDGET_CDN_URL}" data-user-token="${expectedUuid}"></script>`;
    const html = injectMarker(document(aliasTag), buildInjectionSnippet('c1'));
    expect(verifyBuildHtml(html, expectedUuid)).toMatchObject({
      ok: true,
      widgetUuid: expectedUuid,
      widgetLoaderCount: 1,
    });
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
    writeFileSync(
      path.join(root, 'dist', 'index.html'),
      '<html><head></head><body></body></html>',
    );
    writeFileSync(
      path.join(root, 'dist', 'nested', 'about.html'),
      '<html><body></body></html>',
    );
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

  it('skips stale or fragment-only candidates in favour of populated output', () => {
    mkdirSync(path.join(root, 'dist', 'partials'), { recursive: true });
    writeFileSync(path.join(root, 'dist', 'partials', 'card.html'), '<article>old</article>');
    mkdirSync(path.join(root, 'build'), { recursive: true });
    mkdirSync(path.join(root, 'out'), { recursive: true });
    writeFileSync(
      path.join(root, 'out', 'index.html'),
      '<!doctype html><html><head></head><body>current</body></html>',
    );

    expect(resolveBuildDir(root)).toBe(path.join(root, 'out'));
    // Explicit selection stays authoritative even when it contains no full page.
    expect(resolveBuildDir(root, 'dist')).toBe(path.join(root, 'dist'));
  });

  it('requires an explicit directory when multiple populated outputs exist', () => {
    for (const candidate of ['dist', 'out']) {
      mkdirSync(path.join(root, candidate), { recursive: true });
      writeFileSync(
        path.join(root, candidate, 'index.html'),
        `<!doctype html><html><head></head><body>${candidate}</body></html>`,
      );
    }

    expect(() => resolveBuildDir(root)).toThrow(/multiple populated build output directories/);
    expect(resolveBuildDir(root, 'out')).toBe(path.join(root, 'out'));
  });

  it('returns null when no build directory exists', () => {
    expect(resolveBuildDir(root)).toBeNull();
  });
});
