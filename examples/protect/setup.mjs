// Install the vulnerable dependency the demos exploit.
//
// `--no-save`, so it never lands back in `package.json` and never re-enters the repository's dependency
// graph. The exact version comes from `demo-target.mjs`, which is also what the test pins.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEMO_TARGET } from './demo-target.mjs';

const spec = `${DEMO_TARGET.package}@${DEMO_TARGET.version}`;

console.log(`Installing ${spec} — knowingly vulnerable (${DEMO_TARGET.cve}, fixed in ${DEMO_TARGET.fixedIn}).`);
console.log('This is the demo target. It is installed here and not declared as a dependency.\n');

// `fileURLToPath`, not `url.pathname`: the latter keeps percent-encoding, so any directory with a space
// in its name yields a path that does not exist — and the failure surfaces as npm itself being ENOENT.
const here = fileURLToPath(new URL('.', import.meta.url));

// Run npm through the Node binary already running this script when npm launched it (`npm_execpath` is
// npm's own entry point). Falling back to spawning `npm` from PATH keeps `node setup.mjs` working when
// invoked directly, and `shell: true` is what makes that resolve the `.cmd` shim on Windows.
const viaNpmCli = process.env.npm_execpath;
const args = ['install', '--no-save', '--no-audit', '--no-fund', spec];

if (viaNpmCli) {
  execFileSync(process.execPath, [viaNpmCli, ...args], { stdio: 'inherit', cwd: here });
} else {
  execFileSync('npm', args, { stdio: 'inherit', cwd: here, shell: true });
}
