import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI_SOURCE = path.join(REPO_ROOT, 'src', 'cli.ts');
const VITE_NODE = path.join(REPO_ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');
const LOCKFILE_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'package-lock-v3.json');
const SITE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_UUID = '11111111-1111-1111-1111-111111111111';
const ORIGINAL_HTML = '<!doctype html>\n<html><body><div id="app"></div></body></html>\n';

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  body: string;
}

interface StubResponse {
  status: number;
  body: Record<string, unknown>;
}

describe('scan source-widget integration', () => {
  let cwd: string;
  let server: Server;
  let endpoint: string;
  let requests: RecordedRequest[];
  let stubResponse: StubResponse;
  let afterRequest: (() => Promise<void>) | null;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-cli-widget-'));
    await copyFile(LOCKFILE_FIXTURE, path.join(cwd, 'package-lock.json'));
    await writeFile(path.join(cwd, 'index.html'), ORIGINAL_HTML, 'utf8');

    requests = [];
    afterRequest = null;
    stubResponse = {
      status: 200,
      body: {
        uuid: SITE_UUID,
        stored: true,
        manifest_id: 42,
        checksum: 'abc123abc123',
      },
    };
    server = createServer(async (request, response) => {
      let body = '';
      request.setEncoding('utf8');
      for await (const chunk of request) {
        body += chunk;
      }
      requests.push({ method: request.method, url: request.url, body });
      await afterRequest?.();
      response.writeHead(stubResponse.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(stubResponse.body));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Test HTTP server did not bind to a TCP port.');
    }
    endpoint = `http://127.0.0.1:${address.port}/monitor/pulse/manifest`;
  });

  afterEach(async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
    await rm(cwd, { recursive: true, force: true });
  });

  it('persists a provisioned UUID and immediately installs the Vite source widget', async () => {
    await runCli(cwd, ['scan', '--endpoint', endpoint]);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/monitor/pulse/manifest',
    });
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ ecosystem: 'npm' });

    const config = JSON.parse(
      await readFile(path.join(cwd, '.patchstackrc.json'), 'utf8'),
    ) as { siteUuid?: string; endpoint?: string };
    expect(config.siteUuid).toBe(SITE_UUID);
    expect(config.endpoint).toBe(endpoint);

    const html = await readFile(path.join(cwd, 'index.html'), 'utf8');
    expect(html).toContain('https://cdn.patchstack.com/patchstack-widget.js');
    expect(html).toContain(`data-site-uuid="${SITE_UUID}"`);
    expect(html).toContain('data-patchstack-connect-widget="true"');
    expect(html).toContain(`data-api-base="${new URL(endpoint).origin}"`);
    expect((html.match(/patchstack-widget\.js/g) ?? [])).toHaveLength(1);
  });

  it('does not provision a UUID when there is no safe source shell for the widget', async () => {
    await rm(path.join(cwd, 'index.html'));

    const failure = await runCliExpectingFailure(cwd, ['scan', '--endpoint', endpoint]);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('CONFIG_INVALID');
    expect(failure.stderr).toContain('no editable global source shell');
    expect(requests).toHaveLength(0);
    await expect(readFile(path.join(cwd, '.patchstackrc.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('serializes simultaneous first scans so only one bare provisioning request is sent', async () => {
    await Promise.all([
      runCli(cwd, ['scan', '--endpoint', endpoint]),
      runCli(cwd, ['scan', '--endpoint', endpoint]),
    ]);

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.url).sort()).toEqual([
      '/monitor/pulse/manifest',
      `/monitor/pulse/manifest/${SITE_UUID}`,
    ]);
    const config = JSON.parse(
      await readFile(path.join(cwd, '.patchstackrc.json'), 'utf8'),
    ) as { siteUuid?: string; endpoint?: string };
    expect(config).toMatchObject({ siteUuid: SITE_UUID, endpoint });
    const html = await readFile(path.join(cwd, 'index.html'), 'utf8');
    expect((html.match(/patchstack-widget\.js/g) ?? [])).toHaveLength(1);
    await expect(
      readFile(path.join(cwd, '.patchstack-connect.provision.lock'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adopts a legacy source UUID and never sends a bare provisioning request', async () => {
    const legacy =
      `<html><body><script src="https://cdn.patchstack.com/patchstack-widget.js"></script>` +
      `<script>PatchstackWidget.init({ userToken: '${SITE_UUID}' });</script></body></html>`;
    await writeFile(path.join(cwd, 'index.html'), legacy, 'utf8');

    const result = await runCli(cwd, ['scan', '--endpoint', endpoint]);

    expect(result.stdout).toContain('adopted it');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`/monitor/pulse/manifest/${SITE_UUID}`);
    expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(legacy);
    const config = JSON.parse(
      await readFile(path.join(cwd, '.patchstackrc.json'), 'utf8'),
    ) as { siteUuid?: string; endpoint?: string };
    expect(config).toMatchObject({ siteUuid: SITE_UUID, endpoint });
  });

  it.each([
    [
      'unconfigured',
      '<html><body><script src="https://cdn.patchstack.com/patchstack-widget.js"></script></body></html>',
    ],
    [
      'dynamic',
      '<html><body><script src="https://cdn.patchstack.com/patchstack-widget.js"></script>' +
        '<script>PatchstackWidget.init({ userToken: siteUuid });</script></body></html>',
    ],
    [
      'invalid',
      '<html><body><script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="bad"></script></body></html>',
    ],
    [
      'conflicting',
      `<html><body><script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="${SITE_UUID}"></script>` +
        `<script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="${OTHER_UUID}"></script></body></html>`,
    ],
  ])('blocks a %s source widget identity before provisioning', async (_label, html) => {
    await writeFile(path.join(cwd, 'index.html'), html, 'utf8');

    const failure = await runCliExpectingFailure(cwd, ['scan', '--endpoint', endpoint]);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('CONFIG_INVALID');
    expect(requests).toHaveLength(0);
    await expect(readFile(path.join(cwd, '.patchstackrc.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not provision when source-shell selection is ambiguous', async () => {
    await mkdir(path.join(cwd, 'public'), { recursive: true });
    await writeFile(
      path.join(cwd, 'public', 'index.html'),
      '<html><body>second possible shell</body></html>',
    );

    const failure = await runCliExpectingFailure(cwd, ['scan', '--endpoint', endpoint]);
    expect(failure.stderr).toContain('Multiple files could be the global app shell');
    expect(requests).toHaveLength(0);
  });

  it('rejects ambiguous shells before posting for an already configured site', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID, endpoint }, null, 2)}\n`,
    );
    await mkdir(path.join(cwd, 'public'), { recursive: true });
    await writeFile(
      path.join(cwd, 'public', 'index.html'),
      '<html><body>second possible shell</body></html>',
    );

    const failure = await runCliExpectingFailure(cwd, ['scan']);
    expect(failure.stderr).toContain('Multiple files could be the global app shell');
    expect(requests).toHaveLength(0);
  });

  it('does not provision over a manual loader outside the selected global shell', async () => {
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await writeFile(
      path.join(cwd, 'src', 'App.tsx'),
      `const script = document.createElement('script');\n` +
        `script.src = 'https://cdn.patchstack.com/patchstack-widget.js';\n` +
        `PatchstackWidget.init({ userToken: '${SITE_UUID}' });\n`,
    );

    const failure = await runCliExpectingFailure(cwd, ['scan', '--endpoint', endpoint]);
    expect(failure.stderr).toContain('outside the selected global shell');
    expect(requests).toHaveLength(0);
  });

  it('rejects a matching configured widget outside the global shell', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID, endpoint }, null, 2)}\n`,
    );
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await writeFile(
      path.join(cwd, 'src', 'Page.tsx'),
      `<script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="${SITE_UUID}"></script>`,
    );

    const failure = await runCliExpectingFailure(cwd, ['scan']);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('outside the selected global shell');
    expect(failure.stderr).toContain('nested/page-specific loader');
    expect(requests).toHaveLength(0);
    expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(ORIGINAL_HTML);
  });

  it('rejects an external connector-managed widget before provisioning', async () => {
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await writeFile(
      path.join(cwd, 'src', 'Page.tsx'),
      `<script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="${OTHER_UUID}" data-patchstack-connect-widget="true"></script>`,
    );

    const failure = await runCliExpectingFailure(cwd, ['scan', '--endpoint', endpoint]);

    expect(failure.stderr).toContain('outside the selected global shell');
    expect(requests).toHaveLength(0);
    await expect(readFile(path.join(cwd, '.patchstackrc.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('requires a custom Next document when Pages Router routes coexist', async () => {
    const lock = JSON.parse(await readFile(path.join(cwd, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, Record<string, unknown>>;
    };
    const rootDependencies = lock.packages['']?.dependencies as
      | Record<string, string>
      | undefined;
    if (rootDependencies === undefined) throw new Error('fixture root dependencies missing');
    rootDependencies.next = '15.0.0';
    lock.packages['node_modules/next'] = { version: '15.0.0' };
    await writeFile(
      path.join(cwd, 'package-lock.json'),
      `${JSON.stringify(lock, null, 2)}\n`,
    );
    const layout = path.join(cwd, 'src', 'app', 'layout.tsx');
    await mkdir(path.dirname(layout), { recursive: true });
    await writeFile(layout, '<html><body>{children}</body></html>');
    const page = path.join(cwd, 'pages', 'index.tsx');
    await mkdir(path.dirname(page), { recursive: true });
    await writeFile(page, 'export default function Page() { return <main /> }');

    const failure = await runCliExpectingFailure(cwd, ['scan', '--endpoint', endpoint]);

    expect(failure.stderr).toContain('Next Pages Router routes were found');
    expect(failure.stderr).toContain('_document');
    expect(requests).toHaveLength(0);
  });

  it('blocks a configured manual UUID mismatch before posting', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID, endpoint }, null, 2)}\n`,
    );
    const manual =
      `<html><body><script src="https://cdn.patchstack.com/patchstack-widget.js" ` +
      `data-site-uuid="${OTHER_UUID}"></script></body></html>`;
    await writeFile(path.join(cwd, 'index.html'), manual, 'utf8');

    const failure = await runCliExpectingFailure(cwd, ['scan']);
    expect(failure.stderr).toContain('CONFIG_INVALID');
    expect(requests).toHaveLength(0);
    expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(manual);
  });

  it('preserves a matching manual widget and scans its configured site', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID, endpoint }, null, 2)}\n`,
    );
    const manual =
      `<html><body><script src="https://cdn.patchstack.com/patchstack-widget.js" ` +
      `data-site-uuid="${SITE_UUID}"></script></body></html>`;
    await writeFile(path.join(cwd, 'index.html'), manual, 'utf8');

    await runCli(cwd, ['scan']);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`/monitor/pulse/manifest/${SITE_UUID}`);
    expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(manual);
  });

  it('ensures the source widget after scanning an existing site UUID', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID }, null, 2)}\n`,
      'utf8',
    );
    stubResponse = {
      status: 200,
      body: { uuid: SITE_UUID, stored: false, reason: 'duplicate' },
    };

    await runCli(cwd, ['scan', '--endpoint', endpoint]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`/monitor/pulse/manifest/${SITE_UUID}`);
    const html = await readFile(path.join(cwd, 'index.html'), 'utf8');
    expect(html).toContain(`data-site-uuid="${SITE_UUID}"`);
    expect((html.match(/patchstack-widget\.js/g) ?? [])).toHaveLength(1);
  });

  it('fails after saving the UUID when the source shell disappears after the POST', async () => {
    afterRequest = async () => {
      await rm(path.join(cwd, 'index.html'));
    };

    const failure = await runCliExpectingFailure(cwd, ['scan', '--endpoint', endpoint]);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('CONFIG_INVALID');
    expect(failure.stderr).toContain('site 550e8400-e29b-41d4-a716-446655440000 was saved');
    expect(failure.stderr).toContain('without provisioning again');
    expect(requests).toHaveLength(1);
    expect(
      JSON.parse(await readFile(path.join(cwd, '.patchstackrc.json'), 'utf8')),
    ).toMatchObject({ siteUuid: SITE_UUID, endpoint });
  });

  it('does not edit source or make an HTTP request during a dry run', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID }, null, 2)}\n`,
      'utf8',
    );

    await runCli(cwd, ['scan', '--dry-run', '--endpoint', endpoint]);

    expect(requests).toHaveLength(0);
    expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(ORIGINAL_HTML);
  });

  it('treats --dry-run=true as a dry run instead of posting', async () => {
    await runCli(cwd, ['scan', '--dry-run=true', '--endpoint', endpoint]);
    expect(requests).toHaveLength(0);
    expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(ORIGINAL_HTML);
  });

  it.each(['--dryrun', '--dry-run=maybe', '--unknown']) (
    'rejects unsafe or unknown scan option %s before posting',
    async (option) => {
      const failure = await runCliExpectingFailure(cwd, ['scan', option, '--endpoint', endpoint]);
      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain('CONFIG_INVALID');
      expect(requests).toHaveLength(0);
      expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(ORIGINAL_HTML);
    },
  );

  it('honors the persisted widget opt-out while continuing to scan', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID, widget: false }, null, 2)}\n`,
      'utf8',
    );

    await runCli(cwd, ['scan', '--endpoint', endpoint]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`/monitor/pulse/manifest/${SITE_UUID}`);
    expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(ORIGINAL_HTML);
  });

  it('removes a connector-managed widget from build output when opted out', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID, widget: false }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(cwd, 'index.html'),
      ORIGINAL_HTML.replace(
        '</body>',
        `<script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="${SITE_UUID}" defer data-patchstack-connect-widget="true"></script></body>`,
      ),
      'utf8',
    );
    const dist = path.join(cwd, 'dist');
    await mkdir(dist);
    await copyFile(path.join(cwd, 'index.html'), path.join(dist, 'index.html'));

    await runCli(cwd, ['mark-build']);

    const built = await readFile(path.join(dist, 'index.html'), 'utf8');
    expect(built).toContain('data-patchstack-build');
    expect(built).not.toContain('patchstack-widget.js');
    expect(built).not.toContain('data-patchstack-connect-widget');
  });

  it('strictly verifies a static build with the persisted UUID and production signal', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID }, null, 2)}\n`,
      'utf8',
    );
    const dist = path.join(cwd, 'dist');
    await mkdir(dist);
    await writeFile(path.join(dist, 'index.html'), ORIGINAL_HTML, 'utf8');

    const result = await runCli(cwd, ['mark-build', '--strict']);

    expect(result.stdout).toContain('verified the disclosure widget in 1 complete document');
    const built = await readFile(path.join(dist, 'index.html'), 'utf8');
    expect(built).toContain('data-patchstack-build');
    expect(built).toContain(`data-site-uuid="${SITE_UUID}"`);
    expect(built).toContain('data-production="true"');
    expect((built.match(/patchstack-widget\.js/g) ?? [])).toHaveLength(1);
  });

  it('strict mode fails before changing output when no UUID is configured', async () => {
    const dist = path.join(cwd, 'dist');
    await mkdir(dist);
    const output = path.join(dist, 'index.html');
    await writeFile(output, ORIGINAL_HTML, 'utf8');

    const failure = await runCliExpectingFailure(cwd, ['mark-build', '--strict']);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('no site UUID configured');
    expect(await readFile(output, 'utf8')).toBe(ORIGINAL_HTML);
  });

  it('best-effort mark-build preserves a managed source widget when config is missing', async () => {
    const dist = path.join(cwd, 'dist');
    await mkdir(dist);
    const output = path.join(dist, 'index.html');
    const builtFromSource = ORIGINAL_HTML.replace(
      '</body>',
      `<script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="${SITE_UUID}" defer data-patchstack-connect-widget="true"></script></body>`,
    );
    await writeFile(output, builtFromSource, 'utf8');

    await runCli(cwd, ['mark-build']);

    const marked = await readFile(output, 'utf8');
    expect(marked).toContain(`data-site-uuid="${SITE_UUID}"`);
    expect(marked).toContain('data-patchstack-connect-widget="true"');
    expect(marked).toContain('data-patchstack-build');
    expect((marked.match(/patchstack-widget\.js/g) ?? [])).toHaveLength(1);
  });

  it('strict mode fails before changing output when stack coverage cannot be detected', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID }, null, 2)}\n`,
      'utf8',
    );
    await rm(path.join(cwd, 'package-lock.json'));
    const dist = path.join(cwd, 'dist');
    await mkdir(dist);
    const output = path.join(dist, 'index.html');
    await writeFile(output, ORIGINAL_HTML, 'utf8');

    const failure = await runCliExpectingFailure(cwd, ['mark-build', '--strict']);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('could not compute the build fingerprint or detect output coverage');
    expect(failure.stderr).toContain('stopped before changing build output');
    expect(await readFile(output, 'utf8')).toBe(ORIGINAL_HTML);
  });

  it('strict mode validates every document before writing any of them', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID }, null, 2)}\n`,
      'utf8',
    );
    const dist = path.join(cwd, 'dist');
    await mkdir(dist);
    const validOutput = path.join(dist, 'index.html');
    const conflictingOutput = path.join(dist, 'conflict.html');
    const conflictingHtml = ORIGINAL_HTML.replace(
      '</body>',
      `<script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="${OTHER_UUID}"></script></body>`,
    );
    await writeFile(validOutput, ORIGINAL_HTML, 'utf8');
    await writeFile(conflictingOutput, conflictingHtml, 'utf8');

    const failure = await runCliExpectingFailure(cwd, ['mark-build', '--strict']);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('strict production verification failed');
    expect(failure.stderr).toContain('widget-uuid-mismatch');
    expect(failure.stderr).toContain('no output files were changed');
    expect(await readFile(validOutput, 'utf8')).toBe(ORIGINAL_HTML);
    expect(await readFile(conflictingOutput, 'utf8')).toBe(conflictingHtml);
  });

  it('strict mode rejects fragment-only output without mutating it', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID }, null, 2)}\n`,
      'utf8',
    );
    const dist = path.join(cwd, 'dist');
    await mkdir(dist);
    const fragmentFile = path.join(dist, 'fragment.html');
    const fragment = '<div>partial template</div>\n';
    await writeFile(fragmentFile, fragment, 'utf8');

    const failure = await runCliExpectingFailure(cwd, [
      'mark-build',
      '--strict',
      '--dir',
      'dist',
    ]);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('no complete HTML documents');
    expect(await readFile(fragmentFile, 'utf8')).toBe(fragment);
  });

  it('does not let hybrid-capable frameworks pass strict mode from static files alone', async () => {
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      `${JSON.stringify({ siteUuid: SITE_UUID }, null, 2)}\n`,
      'utf8',
    );
    const lock = JSON.parse(await readFile(path.join(cwd, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, Record<string, unknown>>;
    };
    const rootDependencies = lock.packages['']?.dependencies as
      | Record<string, string>
      | undefined;
    if (rootDependencies === undefined) throw new Error('fixture root dependencies missing');
    rootDependencies.next = '15.0.0';
    lock.packages['node_modules/next'] = { version: '15.0.0' };
    await writeFile(
      path.join(cwd, 'package-lock.json'),
      `${JSON.stringify(lock, null, 2)}\n`,
      'utf8',
    );
    const dist = path.join(cwd, 'dist');
    await mkdir(dist);
    const output = path.join(dist, 'index.html');
    await writeFile(output, ORIGINAL_HTML, 'utf8');

    const failure = await runCliExpectingFailure(cwd, ['mark-build', '--strict']);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('detected next');
    expect(failure.stderr).toContain('--static-output');
    expect(await readFile(output, 'utf8')).toBe(ORIGINAL_HTML);

    await runCli(cwd, ['mark-build', '--strict', '--static-output']);
    const built = await readFile(output, 'utf8');
    expect(built).toContain(`data-site-uuid="${SITE_UUID}"`);
    expect(built).toContain('data-production="true"');
  });

  it('rejects --static-output unless strict verification is enabled', async () => {
    const failure = await runCliExpectingFailure(cwd, ['mark-build', '--static-output']);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('--static-output must be used together with --strict');
  });

  it('does not persist a UUID or edit source when the HTTP request fails', async () => {
    stubResponse = {
      status: 500,
      body: { message: 'temporary test failure' },
    };

    const failure = await runCliExpectingFailure(cwd, ['scan', '--endpoint', endpoint]);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('SERVER_ERROR');
    expect(requests).toHaveLength(1);
    await expect(readFile(path.join(cwd, '.patchstackrc.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(ORIGINAL_HTML);
  });

  it('does not persist a UUID or edit source when provisioning omits its UUID', async () => {
    stubResponse = {
      status: 200,
      body: { stored: true, manifest_id: 42, checksum: 'abc123abc123' },
    };

    const failure = await runCliExpectingFailure(cwd, ['scan', '--endpoint', endpoint]);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('SERVER_ERROR');
    expect(failure.stderr).toContain('required to finish provisioning');
    expect(requests).toHaveLength(1);
    await expect(readFile(path.join(cwd, '.patchstackrc.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(ORIGINAL_HTML);
  });

  it('fails on a configured/returned UUID mismatch before changing local files', async () => {
    const configPath = path.join(cwd, '.patchstackrc.json');
    await writeFile(
      configPath,
      `${JSON.stringify({ siteUuid: SITE_UUID, widget: true }, null, 2)}\n`,
      'utf8',
    );
    const configBefore = await readFile(configPath, 'utf8');
    stubResponse = {
      status: 200,
      body: { uuid: OTHER_UUID, stored: true, manifest_id: 42, checksum: 'abc123abc123' },
    };

    const failure = await runCliExpectingFailure(cwd, ['scan', '--endpoint', endpoint]);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('SERVER_ERROR');
    expect(failure.stderr).toContain('No local files were changed');
    expect(requests).toHaveLength(1);
    expect(await readFile(configPath, 'utf8')).toBe(configBefore);
    expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(ORIGINAL_HTML);
  });

  it.each([['--site-uuid='], ['--site-uuid']])(
    'rejects a missing explicit site UUID before provisioning (%s)',
    async (siteUuidFlag) => {
      const failure = await runCliExpectingFailure(cwd, [
        'scan',
        siteUuidFlag,
        '--endpoint',
        endpoint,
      ]);

      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain('CONFIG_INVALID');
      expect(requests).toHaveLength(0);
      await expect(readFile(path.join(cwd, '.patchstackrc.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(path.join(cwd, 'index.html'), 'utf8')).toBe(ORIGINAL_HTML);
    },
  );

  it('init merges the UUID into existing settings', async () => {
    const configPath = path.join(cwd, '.patchstackrc.json');
    await writeFile(
      configPath,
      `${JSON.stringify({ endpoint, timeoutMs: 1234, widget: false }, null, 2)}\n`,
      'utf8',
    );

    await runCli(cwd, ['init', SITE_UUID]);

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      endpoint,
      timeoutMs: 1234,
      widget: false,
      siteUuid: SITE_UUID,
    });
  });

  it('init refuses to replace a different UUID and leaves config untouched', async () => {
    const configPath = path.join(cwd, '.patchstackrc.json');
    await writeFile(
      configPath,
      `${JSON.stringify({ siteUuid: SITE_UUID, endpoint, widget: false }, null, 2)}\n`,
      'utf8',
    );
    const before = await readFile(configPath, 'utf8');

    const failure = await runCliExpectingFailure(cwd, ['init', OTHER_UUID]);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('CONFIG_INVALID');
    expect(failure.stderr).toContain('Refusing to replace existing site UUID');
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });
});

async function runCli(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [VITE_NODE, '--script', CLI_SOURCE, ...args], {
    cwd,
    env: cleanConnectorEnv(),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

async function runCliExpectingFailure(
  cwd: string,
  args: string[],
): Promise<Error & { code?: number | string; stdout?: string; stderr?: string }> {
  try {
    await runCli(cwd, args);
  } catch (error) {
    return error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
  }
  throw new Error('Expected the CLI command to fail.');
}

function cleanConnectorEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.PATCHSTACK_SITE_UUID;
  delete env.PATCHSTACK_ENDPOINT;
  delete env.PATCHSTACK_TIMEOUT_MS;
  delete env.PATCHSTACK_ENVIRONMENT;
  return env;
}
