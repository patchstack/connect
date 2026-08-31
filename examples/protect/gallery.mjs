// Vulnerability GALLERY for @patchstack/connect/protect — a demo-env showcase.
//
// Loads the comprehensive demo rule set and demonstrates, one row per rule, that the exploit is
// blocked/redacted while a benign request to the same surface is allowed — across all three
// phases (request WAF / response leak / egress SSRF). Public/demo rules only; no tokens/secrets.
//
//   cd examples/protect && node gallery.mjs
import { readFileSync } from 'node:fs';
import { runDemoBundle } from './demo-runner.mjs';
import { loadRuntime } from './demo-target.mjs';

const { createProtection } = await loadRuntime();

const bundle = JSON.parse(readFileSync(new URL('./demo-rules.json', import.meta.url), 'utf8'));
const results = await runDemoBundle(bundle, createProtection);

const PHASE_LABEL = { request: 'request  (WAF)', response: 'response (leak)', egress: 'egress   (SSRF)' };
const pad = (s, n) => String(s).padEnd(n);

console.log('\n  Patchstack protect — vulnerability gallery (block mode)\n');
let lastPhase = null;
for (const r of results) {
  if (r.phase !== lastPhase) {
    console.log(`\n  ── ${PHASE_LABEL[r.phase] ?? r.phase} ──`);
    lastPhase = r.phase;
  }
  const verb = r.phase === 'response' ? 'redacted' : 'blocked';
  const mark = r.pass ? '✓' : '✗';
  console.log(`  ${mark} ${pad(r.category, 20)} exploit ${r.exploitCaught ? verb : 'MISSED'} · benign ${r.benignOk ? 'allowed' : 'FALSE-POSITIVE'}`);
  console.log(`      ${pad('', 20)} ${r.desc}`);
}

const passed = results.filter((r) => r.pass).length;
// `passed === results.length` alone is satisfied by zero of zero, so an empty gallery would report
// completion. A gallery with nothing in it has demonstrated nothing.
const ok = results.length > 0 && passed === results.length;
console.log(`\n  ${passed}/${results.length} demonstrations passed across ${new Set(results.map((r) => r.phase)).size} phases.`);

if (results.length === 0) {
  console.log('\n✗ the gallery ran no demonstrations\n');
} else {
  console.log(ok ? '\n✓ gallery complete\n' : '\n✗ some demonstrations failed\n');
}
process.exit(ok ? 0 : 1);
