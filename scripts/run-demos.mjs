// Every demo must run, and must prove what it claims.
//
// The demos are what establishes that the product does what it says, so two things have to hold: the
// process completes, and its output contains the specific claim it exists to make. They are separate
// assertions because a process can exit zero having printed failures, and it can print a banner naming a
// CVE while demonstrating nothing.
//
// Each demo is checked for four things independently: exit status, absence of a failed-step marker, its
// own verdict line, and its proof. The proof pattern must be one an empty or inert run cannot satisfy.
//
// `npm run test:demos`. Requires the built runtime in `dist/` (what an application loads) and the
// on-demand demo target, which this installs.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exampleDir = path.join(root, 'examples', 'protect');

if (!existsSync(path.join(root, 'dist', 'protect.js'))) {
  console.error('  dist/protect.js is missing — run `npm run build` first.');
  process.exit(2);
}

// The vulnerable target is installed on demand rather than declared, so the harness installs it the same
// way a reader would.
console.log('  installing the demo target…');
execFileSync(process.execPath, [path.join(exampleDir, 'setup.mjs')], { cwd: exampleDir, stdio: 'pipe' });

/**
 * Each demo, and what its output must show.
 *
 * `success` is the demo's own verdict line, which it prints only after every step passed. `proof` is the
 * claim the demo exists to make. Both are required, and separately: a demo can exit zero having printed
 * failures, and it can print a banner mentioning the CVE while proving nothing.
 */
const DEMOS = [
  {
    file: 'demo.mjs',
    verdict: /ALL PASS/,
    proof: /PROOF:.*is blocked here, right now/,
  },
  {
    file: 'demo-pulse-chain.mjs',
    verdict: /ALL PASS/,
    proof: /PROOF:.*shielded via a rule delivered by Pulse/,
  },
  {
    file: 'gallery.mjs',
    verdict: /gallery complete/,
    // A count, and it must be non-zero. "0/0 demonstrations passed" satisfies every other assertion.
    proof: /\b([1-9]\d*)\/\1 demonstrations passed across ([1-9]\d*) phases/,
  },
];

let failed = 0;

for (const { file, verdict, proof } of DEMOS) {
  const run = spawnSync(process.execPath, [file], { cwd: exampleDir, encoding: 'utf8' });
  const output = `${run.stdout}${run.stderr}`;

  const checks = {
    exit: run.status === 0,
    // A failed step marker anywhere, whatever the exit code and whatever the summary line claims.
    'no-failed-step': !output.includes('✗'),
    verdict: verdict.test(output),
    proof: proof.test(output),
  };

  const ok = Object.values(checks).every(Boolean);
  if (!ok) failed++;

  const detail = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
    .join(', ');
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${file.padEnd(22)} exit=${run.status}${ok ? '' : `  failed: ${detail}`}`);
  if (!ok) console.log(output.split('\n').slice(-12).map((l) => `        ${l}`).join('\n'));
}

console.log(failed === 0 ? '\n  every demo runs and proves what it claims.' : `\n  ${failed} demo(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
