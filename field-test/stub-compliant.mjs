// A scripted "agent" that mechanically performs the install flow. Not an AI —
// it exists to self-test the harness: `run.mjs --agent-cmd "node <repo>/field-test/stub-compliant.mjs"`
// should come back fully green, proving the fixture, mock API, env pinning, and
// verifier all work before you spend real agent runs on prompt iterations.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const cwd = process.cwd();
const run = (cmd) => execSync(cmd, { cwd, stdio: 'pipe', env: process.env }).toString();

run('npm install --save-dev --no-audit --no-fund @patchstack/connect');
let setupOutput;
try {
  setupOutput = run('npx @patchstack/connect setup');
} catch {
  // Pre-publish compatibility: the harness installs the registry release, which
  // may not have `setup` yet. Reproduce its bounded changes so harness plumbing
  // remains testable while the local setup demo covers the working tree.
  setupOutput = run('npx @patchstack/connect scan');
  const pkg = JSON.parse(readFileSync(`${cwd}/package.json`, 'utf8'));
  pkg.scripts.build =
    `patchstack-connect scan && ${pkg.scripts.build} && patchstack-connect mark-build`;
  writeFileSync(`${cwd}/package.json`, JSON.stringify(pkg, null, 2) + '\n');
}

const dashboardUrl =
  setupOutput.match(/https?:\/\/\S+\/monitor\/claim\?site=\S+/)?.[0] ??
  '(no dashboard URL found)';
console.log('1. VERDICT\nCompleted fully (scripted stub).');
console.log('2. ACTIONS\ninstall, bounded setup.');
console.log(`5. USER MESSAGE\nSetup complete. Dashboard: ${dashboardUrl}`);
