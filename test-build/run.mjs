#!/usr/bin/env node
// One-command end-to-end test of the build hooks against a throwaway example
// site. What it does:
//
//   1. copies test-build/site/ into test-build/.work/ (a fresh fixture each run)
//   2. starts the mocked Patchstack API (field-test/mock-api.mjs) — no real
//      sites are provisioned and nothing leaves the machine
//   3. runs `npm run build` inside the fixture, which exercises the real npm
//      hook mechanism: prebuild → `scan` (provisions a mock UUID, injects the
//      widget tag into index.html), build → copy site to dist/, postbuild →
//      `mark-build` (stamps the production flag + fingerprint)
//   4. verifies dist/index.html carries exactly one widget tag + the prod flag
//   5. serves dist/ on localhost so you can see the widget button in a browser
//
// Usage:
//   node test-build/run.mjs                  # build, verify, serve
//   node test-build/run.mjs --no-serve       # build + verify only (exit code 0/1)
//   node test-build/run.mjs --widget-js /path/to/patchstack-widget.js
//       # serve a local widget build (e.g. sass-webvdp-widget/dist) instead of
//       # loading it from the real CDN
//
// Requires a built connector: run `npm run build` in the repo root first.

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockApi } from '../field-test/mock-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cli = path.join(repoRoot, 'dist', 'cli.js');
const workDir = path.join(here, '.work');
const args = process.argv.slice(2);
const noServe = args.includes('--no-serve');
const widgetJsIdx = args.indexOf('--widget-js');
const widgetJs = widgetJsIdx !== -1 ? path.resolve(args[widgetJsIdx + 1] ?? '') : null;

if (!existsSync(cli)) {
  console.error('dist/cli.js not found — build the connector first: npm run build (in the repo root).');
  process.exit(1);
}
if (widgetJs !== null && !existsSync(widgetJs)) {
  console.error(`--widget-js: ${widgetJs} does not exist.`);
  process.exit(1);
}

// 1. Fresh fixture.
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
cpSync(path.join(here, 'site'), workDir, { recursive: true });
cpSync(path.join(here, 'build.mjs'), path.join(workDir, 'build.mjs'));

// The fixture is a plain npm project; the hooks run the locally built CLI the
// same way `patchstack-connect <cmd>` would run the installed bin.
writeFileSync(
  path.join(workDir, 'package.json'),
  JSON.stringify(
    {
      name: 'patchstack-test-build',
      version: '1.0.0',
      private: true,
      scripts: {
        prebuild: `node ${JSON.stringify(cli)} scan`,
        build: 'node build.mjs',
        postbuild: `node ${JSON.stringify(cli)} mark-build`,
      },
      dependencies: { axios: '^1.6.0', lodash: '^4.17.21' },
    },
    null,
    2,
  ),
);

// A minimal but valid npm v3 lockfile so `scan` has something real to parse.
writeFileSync(
  path.join(workDir, 'package-lock.json'),
  JSON.stringify(
    {
      name: 'patchstack-test-build',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'patchstack-test-build',
          version: '1.0.0',
          dependencies: { axios: '^1.6.0', lodash: '^4.17.21' },
        },
        'node_modules/axios': {
          version: '1.6.0',
          resolved: 'https://registry.npmjs.org/axios/-/axios-1.6.0.tgz',
          integrity: 'sha512-fixture',
        },
        'node_modules/lodash': {
          version: '4.17.21',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
          integrity: 'sha512-fixture',
        },
      },
    },
    null,
    2,
  ),
);

// 2. Mock API.
const mock = await startMockApi();
console.log(`mock Patchstack API on ${mock.endpoint} (site uuid ${mock.uuid})\n`);

// 3. The real npm hook mechanism: prebuild → build → postbuild. Must be async
// (not spawnSync) so the in-process mock API can answer while the build runs.
const buildStatus = await new Promise((resolve) => {
  const child = spawn('npm', ['run', 'build'], {
    cwd: workDir,
    stdio: 'inherit',
    env: { ...process.env, PATCHSTACK_ENDPOINT: mock.endpoint, NO_COLOR: '1' },
  });
  child.on('close', resolve);
  child.on('error', () => resolve(1));
});
if (buildStatus !== 0) {
  console.error('\n✖ npm run build failed inside the fixture.');
  await mock.close();
  process.exit(1);
}

// 4. Verify the artifacts the hooks are responsible for.
const distDir = path.join(workDir, 'dist');
const builtHtml = readFileSync(path.join(distDir, 'index.html'), 'utf8');
const sourceHtml = readFileSync(path.join(workDir, 'index.html'), 'utf8');
const widgetTags = builtHtml.split('patchstack-widget.js').length - 1;

const checks = [
  ['scan wrote .patchstackrc.json with the mock UUID',
    existsSync(path.join(workDir, '.patchstackrc.json')) &&
    readFileSync(path.join(workDir, '.patchstackrc.json'), 'utf8').includes(mock.uuid)],
  ['scan injected the widget tag into the source shell (index.html)',
    sourceHtml.includes(`data-site-uuid="${mock.uuid}"`)],
  ['built HTML carries exactly one widget tag', widgetTags === 1],
  ['mark-build stamped the production flag', builtHtml.includes('window.__PATCHSTACK_PROD__=true')],
  ['mark-build stamped the build fingerprint', builtHtml.includes('window.__PATCHSTACK_BUILD__=')],
  ['scan posted the manifest to the (mock) API',
    mock.requests.some((r) => r.method === 'POST' && r.url.startsWith('/monitor/pulse/manifest'))],
];

console.log('');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(` ${ok ? '✔' : '✖'} ${label}`);
  if (!ok) failed += 1;
}

if (failed > 0) {
  console.error(`\n✖ ${failed} check(s) failed. Fixture kept at ${workDir} for inspection.`);
  await mock.close();
  process.exit(1);
}
console.log('\n✔ all checks passed.');

if (noServe) {
  await mock.close();
  process.exit(0);
}

// 5. Serve the built site. `--widget-js` swaps the CDN loader for a local
// widget build so widget changes can be tested before they reach the CDN.
if (widgetJs !== null) {
  cpSync(widgetJs, path.join(distDir, 'patchstack-widget.js'));
  writeFileSync(
    path.join(distDir, 'index.html'),
    builtHtml.replace('https://cdn.patchstack.com/patchstack-widget.js', '/patchstack-widget.js'),
  );
  console.log(`serving local widget build: ${widgetJs}`);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(distDir, urlPath === '/' ? 'index.html' : urlPath);
  if (!path.resolve(file).startsWith(distDir) || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

server.listen(4173, '127.0.0.1', () => {
  console.log('\nserving the production build on http://localhost:4173');
  console.log('  → the "Report a vulnerability" button should appear bottom-right');
  console.log('  → the page carries the production flag, so the widget shows report-only UI');
  console.log('    (append #patchstack to the URL to reveal the owner login flow)');
  console.log('\nCtrl+C to stop (this also stops the mock API).');
});
