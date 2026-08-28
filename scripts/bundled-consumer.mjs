// Can a BUNDLER take this package apart without breaking it?
//
// Most consumers of `@patchstack/connect/protect` are bundled: a Cloudflare Worker through wrangler, a
// Next edge middleware, a Vite or SvelteKit adapter build. All of them tree-shake, and a tree-shaken
// guard that has lost the part which screens requests still starts, still logs, still looks installed.
// That is the defect class this whole package exists to avoid, arriving through the consumer's build
// rather than ours.
//
// So this does not measure bundle size and stop. It bundles a real edge guard, minifies it, and then puts
// the published CVE-2017-5941 exploit through the bundled output — the same artifact and the same request
// as `tests/protect/canary-engine-proof.test.ts`, so a shaken-out branch shows up as an exploit that is
// no longer blocked instead of as a smaller file.
//
// It runs twice, with and without `sideEffects: false` in the installed manifest, because that field is a
// promise to the bundler that it may drop unevaluated modules. The two runs are what turns declaring it
// from an assumption into a measurement: the sizes say whether the field buys anything, and the canary
// says whether it costs correctness.
//
// `npm run test:bundled`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = JSON.parse(
  readFileSync(path.join(root, 'tests', 'protect', 'fixtures', 'canary', 'cve-2017-5941.rule.json'), 'utf8'),
);

// Same shapes as the canary test, deliberately duplicated rather than imported: this script runs against
// an INSTALLED tarball in a temporary directory, and reaching back into the repository's test helpers is
// how a packaging test ends up proving something about the repository instead of about the package.
const EXPLOIT = JSON.stringify({
  state: '_$$ND_FUNC$$_function (){ require("child_process").exec("id > /tmp/pwned", function(){}); }()',
});
const BENIGN = JSON.stringify({ state: '{"cart":[{"sku":"AB-1","qty":2}],"currency":"EUR"}' });

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function pack() {
  const out = mkdtempSync(path.join(tmpdir(), 'ps-pack-'));
  // `npm pack` runs `prepare`, so the tarball is built from the current sources rather than a stale dist.
  run('npm', ['pack', '--pack-destination', out], root);
  const name = `patchstack-connect-${JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version}.tgz`;
  return path.join(out, name);
}

// A second shape: one small symbol from the ROOT entry. The guard shape above pulls in the whole runtime
// by design, so it cannot show tree-shaking working or failing — this can. It is also the question of
// entry hygiene: whether importing one helper from the root drags the CLI, the scaffolder and the
// TypeScript-dependent map analysis in behind it.
// `compareVersions` is a small pure function with no dependencies of its own, chosen so that whatever
// survives in the bundle is what CANNOT be shaken out rather than what this import needed.
const ROOT_IMPORT = `
import { compareVersions } from '@patchstack/connect';

export const compare = compareVersions;
console.log(compare('1.0.0', '1.0.1'));
`;

const GUARD = `
import { createProtection } from '@patchstack/connect/protect';
import RULE from './rule.json' with { type: 'json' };

const ready = createProtection({ rules: { firewall: [RULE], whitelists: [], whitelist_keys: {} }, mode: 'block' });

export async function screen(request) {
  const protection = await ready;
  return protection.fetchGuard()(request);
}
`;

// The bundled guard is exercised in a SEPARATE process from a file on disk, so what is tested is the
// artifact the bundler emitted and not a module graph this script still has warm in memory.
const HARNESS = `
import { screen } from './bundle.js';

const post = (body, url) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const exploit = await screen(post(${JSON.stringify(EXPLOIT)}, 'https://app.test/api/restore'));
const benign = await screen(post(${JSON.stringify(BENIGN)}, 'https://app.test/api/restore'));
const other = await screen(post(${JSON.stringify(EXPLOIT)}, 'https://app.test/api/profile'));

console.log(JSON.stringify({
  exploit: exploit ? exploit.status : null,
  benign: benign ? benign.status : null,
  scoped: other ? other.status : null,
}));
`;

function measure(tarball, { shape, sideEffectsFalse = false, dropModule = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-bundle-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'c', private: true, type: 'module' }, null, 2));
  run('npm', ['install', '--no-audit', '--no-fund', tarball], dir);

  const installed = path.join(dir, 'node_modules', '@patchstack', 'connect', 'package.json');
  const manifest = JSON.parse(readFileSync(installed, 'utf8'));
  if (sideEffectsFalse) manifest.sideEffects = false;
  else delete manifest.sideEffects;
  // `module` predates `exports` and is only consulted by bundlers that ignore `exports`. Removing it and
  // comparing byte counts is how we learn whether it is still doing anything, rather than keeping it
  // because removing it feels risky.
  if (dropModule) delete manifest.module;
  writeFileSync(installed, JSON.stringify(manifest, null, 2));

  const edge = shape === 'edge-guard';
  writeFileSync(path.join(dir, 'guard.js'), edge ? GUARD : ROOT_IMPORT);
  writeFileSync(path.join(dir, 'rule.json'), JSON.stringify(artifact.rule));

  // The edge shape resolves `protect.edge.js` through the `workerd` export condition — the build most
  // likely to differ from what the tests cover, and the one with a hard size limit. The root shape is
  // bundled for Node, which is where a root import actually happens.
  run(path.join(root, 'node_modules', '.bin', 'esbuild'), [
    'guard.js', '--bundle', '--minify', '--format=esm', '--outfile=bundle.js', '--log-level=error',
    '--loader:.json=json',
    ...(edge ? ['--platform=browser', '--conditions=workerd'] : ['--platform=node']),
  ], dir);

  const bytes = statSync(path.join(dir, 'bundle.js')).size;
  let verdict = null;
  if (edge) {
    writeFileSync(path.join(dir, 'harness.mjs'), HARNESS);
    verdict = JSON.parse(run(process.execPath, ['harness.mjs'], dir).trim());
  }

  rmSync(dir, { recursive: true, force: true });
  return { bytes, verdict };
}

const tarball = pack();
console.log(`bundling an edge guard from ${path.basename(tarball)} with esbuild ${run(path.join(root, 'node_modules', '.bin', 'esbuild'), ['--version'], root).trim()}\n`);

// Ceilings, not pins. Generous over what is measured today (0.8 kB root, 97 kB edge guard) so ordinary
// growth does not trip them, and low enough to catch the two regressions that matter: a top-level side
// effect or a heavy static import added to the ROOT entry, which would put the whole scanner into every
// consumer's bundle; and the edge guard doubling, which is the one with a hard platform limit.
const CEILING = { 'root-import': 8 * 1024, 'edge-guard': 200 * 1024 };

const CONFIGS = [
  { label: 'as published', opts: {} },
  { label: 'sideEffects: false', opts: { sideEffectsFalse: true } },
  { label: 'no `module` field', opts: { dropModule: true } },
];

let failed = 0;
const sizes = {};

for (const shape of ['edge-guard', 'root-import']) {
  console.log(`  ${shape === 'edge-guard' ? 'edge guard (workerd condition, runs the canary)' : 'one symbol from the root entry'}`);
  sizes[shape] = {};

  for (const { label, opts } of CONFIGS) {
    const { bytes, verdict } = measure(tarball, { shape, ...opts });
    sizes[shape][label] = bytes;

    const overCeiling = bytes > CEILING[shape];
    if (overCeiling) {
      failed++;
      console.log(
        `    FAIL  ${label.padEnd(20)} ${(bytes / 1024).toFixed(1).padStart(7)} kB   ` +
          `over the ${(CEILING[shape] / 1024).toFixed(0)} kB ceiling for this shape`,
      );
      continue;
    }

    if (verdict === null) {
      console.log(`    ok    ${label.padEnd(20)} ${(bytes / 1024).toFixed(1).padStart(7)} kB`);
      continue;
    }
    // Blocked, benign allowed, scope honoured — asserted on the bundled output, which is the only place a
    // shaken-away branch can be observed.
    const ok = verdict.exploit === 403 && verdict.benign === null && verdict.scoped === null;
    if (!ok) failed++;
    console.log(
      `    ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(20)} ${(bytes / 1024).toFixed(1).padStart(7)} kB   ` +
        `exploit=${verdict.exploit} benign=${verdict.benign ?? 'allowed'} other-route=${verdict.scoped ?? 'allowed'}`,
    );
  }
  console.log('');
}

const describe = (shape, label) => {
  const delta = sizes[shape]['as published'] - sizes[shape][label];
  if (delta === 0) return 'no change';
  return `${delta > 0 ? '-' : '+'}${(Math.abs(delta) / 1024).toFixed(1)} kB`;
};

for (const label of ['sideEffects: false', 'no `module` field']) {
  console.log(`  \`${label}\`: edge guard ${describe('edge-guard', label)}, root import ${describe('root-import', label)}`);
}

// What this measurement can and cannot settle, stated here so a future reader does not take the second
// line above for more than it is. esbuild resolves through `exports`, so it never consults `module`; a
// zero delta means this bundler does not need the field, NOT that no bundler does. Webpack 4 and older
// rollup setups predate `exports` and fall back to `module`. Keeping it costs one line.
if (sizes['root-import']['no `module` field'] === sizes['root-import']['as published']) {
  console.log(
    '\n  note: the `module` result only shows that a bundler which reads `exports` ignores the field.\n' +
      '        It is not evidence that dropping it is safe for bundlers that predate `exports`.',
  );
}

if (failed > 0) {
  console.error('\nA bundled guard did not behave like the engine it was built from. Do not ship this.');
  process.exit(1);
}
rmSync(path.dirname(tarball), { recursive: true, force: true });
console.log('\n  the bundled guard blocks the exploit and allows the control in every configuration.');
