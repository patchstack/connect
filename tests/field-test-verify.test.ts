import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verify } from '../field-test/verify.mjs';

const uuid = '550e8400-e29b-41d4-a716-446655440000';
const endpoint = 'http://127.0.0.1:12345/monitor/pulse/manifest';
const dashboard = `http://127.0.0.1:12345/monitor/claim?site=${uuid}`;
const baselineScripts = { dev: 'vite', 'build:dev': 'vite build --mode development', build: 'vite build' };
let dir: string;
let mock: { uuid: string; endpoint: string; requests: { method: string; url: string }[] };
const write = (file: string, text: string) => writeFileSync(path.join(dir, file), text);
const score = (output = dashboard) => verify(dir, mock, output, baselineScripts);

function editPackage(edit: (pkg: any) => void) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  edit(pkg);
  write('package.json', JSON.stringify(pkg));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'field-verify-'));
  mock = { uuid, endpoint, requests: [{ method: 'POST', url: '/monitor/pulse/manifest' }] };
  mkdirSync(path.join(dir, 'node_modules/@patchstack/connect/dist'), { recursive: true });
  write('node_modules/@patchstack/connect/AGENT-INSTALL.md', 'Synthetic package documentation.');
  write('node_modules/@patchstack/connect/dist/cli.js', "console.log('guard is wired ✓');\n");
  write('.patchstackrc.json', JSON.stringify({ siteUuid: uuid }));
  write('package.json', JSON.stringify({ dependencies: { '@patchstack/connect': '1.0.0' }, scripts: {
    ...baselineScripts,
    prebuild: 'patchstack-connect scan', postbuild: 'patchstack-connect mark-build', postinstall: 'patchstack-connect scan',
  } }));
  write('index.html', `<html><body><script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="${uuid}" defer></script></body></html>`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('field-test install evidence', () => {
  it('passes a complete installation and invokes only the source check', () => {
    write('node_modules/@patchstack/connect/dist/cli.js', `
      if (process.argv.slice(2).join(' ') !== 'protect --check') process.exit(1);
      if (process.env.PATCHSTACK_ENDPOINT !== ${JSON.stringify(endpoint)}) process.exit(2);
      console.log('guard is wired ✓');
    `);
    const result = score(`Open [your dashboard](${dashboard}).`);
    expect(result.passed).toBe(result.total);
    expect(result.audited).toBe(true);
    expect(result.refused).toBe(false);
  });

  it('rejects a development-only dependency even when the tarball is unpacked', () => {
    editPackage((pkg) => { pkg.devDependencies = pkg.dependencies; delete pkg.dependencies; });
    expect(score().checks.installed.pass).toBe(false);
    expect(score().audited).toBe(true);
  });

  it('treats a declaration without unpacked docs as void', () => {
    rmSync(path.join(dir, 'node_modules'), { recursive: true });
    expect(score()).toMatchObject({ audited: false, checks: { installed: { pass: false } } });
  });

  it.each([0, 2])('requires exactly one provisioning request (%s)', (count) => {
    mock.requests = Array.from({ length: count }, () => ({ method: 'POST', url: '/monitor/pulse/manifest' }));
    expect(score().checks.provisionedOnce.pass).toBe(false);
  });

  it('does not mistake a UUID in config or a comment for widget wiring', () => {
    write('index.html', `<!-- <script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="${uuid}"></script> -->`);
    write('README.md', `Widget: patchstack-widget ${uuid}`);
    const result = score();
    expect(result.checks.widgetInstalled.pass).toBe(false);
    expect(result.checks.widgetTokenMatches.pass).toBe(false);
  });

  it('requires the UUID on the widget tag itself', () => {
    write('index.html', `<script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="wrong"></script><p>${uuid}</p>`);
    expect(score().checks.widgetTokenMatches.pass).toBe(false);
  });

  it('rejects duplicated widget tags', () => {
    const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
    write('index.html', html + html);
    expect(score().checks.widgetInstalled.pass).toBe(false);
  });

  it('detects changes to development scripts and a missing dependency-install hook', () => {
    editPackage((pkg) => { pkg.scripts.dev = 'patchstack-connect scan && vite'; delete pkg.scripts.postinstall; });
    expect(score().checks.devScriptsPreserved.pass).toBe(false);
    expect(score().checks.dependencyScanWired.pass).toBe(false);
  });

  it.each(['config', 'script', 'env'])('detects a persisted sandbox override in %s', (where) => {
    if (where === 'config') write('.patchstackrc.json', JSON.stringify({ siteUuid: uuid, environment: 'sandbox' }));
    if (where === 'script') editPackage((pkg) => { pkg.scripts.build = 'PATCHSTACK_ENVIRONMENT=sandbox vite build'; });
    if (where === 'env') write('.env.production', 'PATCHSTACK_ENVIRONMENT="sandbox"\n');
    expect(score().checks.sandboxNotPersisted.pass).toBe(false);
  });

  it.each(['http://127.0.0.1:12345/monitor/claim?site=wrong', `https://example.com/monitor/claim?site=${uuid}`])('rejects the wrong dashboard URL: %s', (url) => {
    expect(score(url).checks.claimUrlSurfaced.pass).toBe(false);
  });

  it.each(["console.log('guard is wired ✓'); process.exit(1);", "console.log('success');"])('rejects failed or unrecognised protection results', (source) => {
    write('node_modules/@patchstack/connect/dist/cli.js', source);
    expect(score().checks.protectionVerified.pass).toBe(false);
  });

  it('accepts a static project without claiming runtime protection', () => {
    write('node_modules/@patchstack/connect/dist/cli.js', "console.log('no guard to wire — this project has no request path');");
    expect(score().checks.protectionVerified).toMatchObject({ pass: true, detail: expect.stringContaining('not applicable') });
  });

  it('does not call a normal install message a refusal', () => {
    mock.requests = [];
    write('.patchstackrc.json', '{}');
    expect(score('Installed the dependency.').refused).toBe(false);
    expect(score('I refuse to continue.').refused).toBe(true);
  });
});
