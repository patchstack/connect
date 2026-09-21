// Demonstrate the no-agent onboarding path against the locally built package:
// install once, run one bounded setup command, then verify the result.
//
//   npm run build
//   node field-test/setup-demo.mjs [--keep] [--template express-npm]
//
// The manifest API is mocked; dependency installation still uses the npm registry.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture } from './fixture.mjs';
import { startMockApi } from './mock-api.mjs';
import { verify } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const keep = process.argv.includes('--keep');
const templateArg = process.argv.indexOf('--template');
const template = templateArg === -1 ? 'lovable-bun' : process.argv[templateArg + 1];
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
  makeFixture(fixture, template);
  const baselineScripts = JSON.parse(readFileSync(path.join(fixture, 'package.json'), 'utf8')).scripts;

  const packed = spawnSync(
    'npm',
    ['pack', '--ignore-scripts', '--pack-destination', fixture],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (packed.status !== 0) {
    throw new Error(`npm pack failed: ${packed.stderr}`);
  }
  const tarballs = readdirSync(fixture).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error('npm pack must produce exactly one tarball');
  const tarball = path.join(fixture, tarballs[0]);

  console.log('\n1. Install the local package as a regular dependency');
  if ((await run('npm', ['install', '--save', tarball], { cwd: fixture })) !== 0) {
    throw new Error('fixture install failed');
  }

  mock = await startMockApi();
  const env = { ...process.env, PATCHSTACK_ENDPOINT: mock.endpoint, NO_COLOR: '1' };

  console.log('\n2. Run the single bounded setup command');
  if ((await run('npx', ['--no-install', 'patchstack-connect', 'setup'], { cwd: fixture, env })) !== 0) {
    throw new Error('setup failed');
  }

  console.log('\n3. Re-run setup to prove it is idempotent');
  if ((await run('npx', ['--no-install', 'patchstack-connect', 'setup'], { cwd: fixture, env })) !== 0) {
    throw new Error('second setup failed');
  }

  const pkg = JSON.parse(readFileSync(path.join(fixture, 'package.json'), 'utf8'));
  const html = readFileSync(path.join(fixture, 'index.html'), 'utf8');
  const rc = JSON.parse(readFileSync(path.join(fixture, '.patchstackrc.json'), 'utf8'));
  const build = pkg.scripts?.build ?? '';
  const scanScript = template === 'lovable-bun' ? build : pkg.scripts?.prebuild ?? '';
  const markScript = template === 'lovable-bun' ? build : pkg.scripts?.postbuild ?? '';
  const claimUrl = `${new URL(mock.endpoint).origin}/monitor/claim?site=${mock.uuid}`;
  const verdict = verify(fixture, mock, claimUrl, baselineScripts);
  const checks = [
    ['package declared as a regular dependency', pkg.dependencies?.['@patchstack/connect'] !== undefined],
    ['one site provisioned and reused', rc.siteUuid === mock.uuid && mock.requests[0]?.url === '/monitor/pulse/manifest'],
    ['scan wired once', count(scanScript, 'patchstack-connect scan') === 1],
    ['mark-build wired once', count(markScript, 'patchstack-connect mark-build') === 1],
    ['widget installed once with the site UUID', count(html, 'patchstack-widget.js') === 1 && html.includes(mock.uuid)],
    ...Object.entries(verdict.checks)
      .filter(([name]) => name !== 'claimUrlSurfaced' && name !== 'noProductionLeak')
      .map(([name, check]) => [name, check.pass]),
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
