// A scripted "agent" that mechanically performs the install flow. Not an AI —
// it exists to self-test the harness: `run.mjs --agent-cmd "node <repo>/field-test/stub-compliant.mjs"`
// should come back fully green, proving the fixture, mock API, env pinning, and
// verifier all work before you spend real agent runs on prompt iterations.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const cwd = process.cwd();
const run = (cmd) => execSync(cmd, { cwd, stdio: 'pipe', env: process.env }).toString();

run('npm install --save-dev --no-audit --no-fund @patchstack/connect');
const scanOutput = run('npx --no-install patchstack-connect scan');

const rc = JSON.parse(readFileSync(`${cwd}/.patchstackrc.json`, 'utf8'));

const pkg = JSON.parse(readFileSync(`${cwd}/package.json`, 'utf8'));
pkg.scripts = {
  ...pkg.scripts,
  prebuild: 'patchstack-connect scan',
  postbuild: 'patchstack-connect mark-build --strict',
};
writeFileSync(`${cwd}/package.json`, JSON.stringify(pkg, null, 2) + '\n');

const widget =
  `    <script src="https://cdn.patchstack.com/patchstack-widget.js" ` +
  `data-site-uuid="${rc.siteUuid}" defer data-patchstack-connect-widget="true"></script>\n`;
const html = readFileSync(`${cwd}/index.html`, 'utf8');
writeFileSync(`${cwd}/index.html`, html.replace('</body>', `${widget}  </body>`));

const claimUrl = scanOutput.match(/https?:\/\/\S+\/monitor\/claim\?site=\S+/)?.[0] ?? '(no claim URL found)';
console.log('1. VERDICT\nCompleted fully (scripted stub).');
console.log('2. ACTIONS\ninstall, scan, wire hooks, add widget.');
console.log(`5. USER MESSAGE\nSetup complete. Claim your site: ${claimUrl}`);
