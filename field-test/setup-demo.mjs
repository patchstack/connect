// Demonstrate the no-agent onboarding path against the locally built package:
// install once, run one bounded setup command, then verify the result.
//
//   npm run build
//   node field-test/setup-demo.mjs [--keep]
//
// The Patchstack API is mocked; nothing leaves the machine.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture } from './fixture.mjs';
import { startMockApi } from './mock-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const keep = process.argv.includes('--keep');
const fixture = mkdtempSync(path.join(tmpdir(), 'patchstack-setup-demo-'));

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('close', resolve);
    child.on('error', () => resolve(1));
  });
}

function count(content, needle) {
  return content.split(needle).length - 1;
}

let mock;
try {
  console.log(`fixture: ${fixture}`);
  makeFixture(fixture, 'lovable-bun');

  const packed = spawnSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', fixture],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (packed.status !== 0) {
    throw new Error(`npm pack failed: ${packed.stderr}`);
  }
  const filename = JSON.parse(packed.stdout)[0].filename;
  const tarball = path.join(fixture, filename);

  console.log('\n1. Install the local package as a dev dependency');
  if ((await run('npm', ['install', '--save-dev', tarball], { cwd: fixture })) !== 0) {
    throw new Error('fixture install failed');
  }

  mock = await startMockApi();
  const env = { ...process.env, PATCHSTACK_ENDPOINT: mock.endpoint, NO_COLOR: '1' };

  console.log('\n2. Run the single bounded setup command');
  if ((await run('npx', ['--yes', 'patchstack-connect', 'setup'], { cwd: fixture, env })) !== 0) {
    throw new Error('setup failed');
  }

  console.log('\n3. Re-run setup to prove it is idempotent');
  if ((await run('npx', ['--yes', 'patchstack-connect', 'setup'], { cwd: fixture, env })) !== 0) {
    throw new Error('second setup failed');
  }

  const pkg = JSON.parse(readFileSync(path.join(fixture, 'package.json'), 'utf8'));
  const html = readFileSync(path.join(fixture, 'index.html'), 'utf8');
  const rc = JSON.parse(readFileSync(path.join(fixture, '.patchstackrc.json'), 'utf8'));
  const build = pkg.scripts?.build ?? '';
  const checks = [
    ['package declared as a dev dependency', pkg.devDependencies?.['@patchstack/connect'] !== undefined],
    ['one site provisioned and reused', rc.siteUuid === mock.uuid && mock.requests[0]?.url === '/monitor/pulse/manifest'],
    ['Bun-compatible scan wired once', count(build, 'patchstack-connect scan') === 1],
    ['Bun-compatible mark-build wired once', count(build, 'patchstack-connect mark-build') === 1],
    ['widget installed once with the site UUID', count(html, 'patchstack-widget.js') === 1 && html.includes(mock.uuid)],
    ['no protect command was run', !mock.requests.some((request) => request.url?.includes('protect'))],
  ];

  console.log('\nDemo result');
  let failed = 0;
  for (const [label, passed] of checks) {
    console.log(` ${passed ? '✔' : '✖'} ${label}`);
    if (!passed) failed += 1;
  }
  console.log(`\nFinal build command: ${build}`);
  if (failed > 0) {
    throw new Error(`${failed} demo check(s) failed`);
  }
} finally {
  if (mock) await mock.close();
  if (keep) {
    console.log(`\nFixture kept at ${fixture}`);
  } else if (existsSync(fixture)) {
    rmSync(fixture, { recursive: true, force: true });
  }
}
