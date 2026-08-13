// Platform-integration check: compile `@patchstack/connect/protect` with the REAL Cloudflare Workers
// toolchain (wrangler), not a simulation.
//
// Why this exists separately from the test suite: it downloads wrangler and shells out to a platform
// bundler, so it needs network and takes far longer than a unit test — it must not sit in `npm test`
// (which CI runs on four Node versions). The suite covers the same property two cheaper ways:
//   - tests/protect/edge-bundle.test.ts        — the artifact is edge-bundleable and still enforces
//   - tests/protect/edge-export-resolution.test.ts — a consumer's import resolves to the edge branch
// This script is the end-to-end confirmation that a real platform bundler agrees.
//
//   node scripts/verify-edge-platform.mjs      (or: npm run verify:edge)
//
// Exits non-zero on failure, so it can be wired into a release job.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = fileURLToPath(new URL('..', import.meta.url));
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

if (!existsSync(join(repo, 'dist', 'protect.edge.js'))) {
  console.log('building dist/ first…');
  execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit' });
}

const dir = mkdtempSync(join(tmpdir(), 'ps-edge-platform-'));
try {
  mkdirSync(join(dir, 'node_modules', '@patchstack'), { recursive: true });
  symlinkSync(repo, join(dir, 'node_modules', '@patchstack', 'connect'), 'dir');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ps-edge-fixture', private: true, type: 'module' }));
  writeFileSync(join(dir, 'wrangler.toml'), [
    'name = "ps-edge-fixture"',
    'main = "worker.js"',
    'compatibility_date = "2024-09-01"',
    '',
  ].join('\n'));
  // A realistic Worker: build the guard once, screen every request through it.
  writeFileSync(join(dir, 'worker.js'), [
    'import { createProtection } from "@patchstack/connect/protect";',
    'let guard;',
    'export default {',
    '  async fetch(request) {',
    '    guard ??= await createProtection({ rules: { firewall: [], whitelists: [], whitelist_keys: {} }, mode: "block" });',
    '    return (await guard.fetchGuard()(request)) ?? new Response("ok");',
    '  },',
    '};',
    '',
  ].join('\n'));

  console.log('compiling with wrangler (real Workers bundler)…');
  execFileSync('npx', ['--yes', 'wrangler@4', 'deploy', '--dry-run', '--outdir=out'], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  });

  const out = join(dir, 'out', 'worker.js');
  if (!existsSync(out)) fail('wrangler produced no bundle');
  const bundle = readFileSync(out, 'utf8');

  // The edge artifact is the only one carrying the Node-only stub message: proves the `workerd`
  // condition selected it rather than the Node build.
  if (!bundle.includes('Node-only')) fail('wrangler resolved the NODE build, not dist/protect.edge.js');
  const nodeImports = bundle.match(/from\s*["'](?:node:)?(?:fs|fs\/promises|path|dns|net|os|child_process)["']/g);
  if (nodeImports) fail(`Workers bundle references Node builtins: ${[...new Set(nodeImports)].join(', ')}`);

  console.log('\nOK: wrangler compiled the Worker, selected dist/protect.edge.js, and the bundle has no Node builtins.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
