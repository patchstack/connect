import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WIDGET_MARKER_ATTR,
  WIDGET_SCRIPT_URL,
  buildWidgetTag,
  ensureSourceWidget,
  ensureWidgetInHtml,
  findSourceShell,
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
