// A scripted "agent" that mechanically performs the install flow. Not an AI —
// it exists to self-test the harness: `run.mjs --agent-cmd "node <repo>/field-test/stub-compliant.mjs"`
// should come back fully green, proving the fixture, mock API, env pinning, and
// verifier all work before you spend real agent runs on prompt iterations.
import { execSync } from 'node:child_process';

const cwd = process.cwd();
const run = (cmd) => execSync(cmd, { cwd, stdio: 'pipe', env: process.env }).toString();

run('npm install --save --no-audit --no-fund @patchstack/connect');
const setupOutput = run('npx --no-install patchstack-connect setup');
run('npx --no-install patchstack-connect protect --check');

const dashboardUrl =
  setupOutput.match(/https?:\/\/\S+\/monitor\/claim\?site=\S+/)?.[0] ??
  '(no dashboard URL found)';
console.log('1. VERDICT\nCompleted fully (scripted stub).');
console.log('2. ACTIONS\ninstall, bounded setup.');
console.log(`5. USER MESSAGE\nSetup complete. Dashboard: ${dashboardUrl}`);
