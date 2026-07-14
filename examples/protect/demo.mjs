// End-to-end "Verified Vulnerability Shielding" demo for @patchstack/connect/protect.
//
// A REAL, unmodified vulnerable dependency (lodash@4.17.11, CVE-2019-10744) is exploited
// live through an app endpoint; then the vPatch is applied and the SAME exploit is replayed
// and blocked — with an auditable proof. Also demonstrates response secret-leak redaction
// and egress SSRF blocking. Public CVE + demo rules only; no tokens/secrets.
//
//   cd examples/protect && npm install && node demo.mjs
import { readFileSync } from 'node:fs';
import _ from 'lodash';
import { createProtection } from '../../src/protect/runtime.js';

const rules = JSON.parse(readFileSync(new URL('./rules.demo.json', import.meta.url), 'utf8'));
const LODASH = _.VERSION; // 4.17.11 (vulnerable; fixed in 4.17.12)

let ok = true;
const line = (pass, msg) => { ok = pass && ok; console.log(`  ${pass ? '✓' : '✗'}  ${msg}`); };

// The vulnerable app endpoint: "save settings" deep-merges the JSON body via lodash — the
// CVE-2019-10744 sink.
const appHandler = async (request) => {
  const body = await request.json().catch(() => ({}));
  _.defaultsDeep({}, body); // vulnerable sink
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const exploit = () =>
  new Request('https://app.demo/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"constructor":{"prototype":{"polluted":"yes"}}}',
  });

const polluted = () => {
  const hit = ({}).polluted === 'yes';
  delete Object.prototype.polluted;
  return hit;
};

console.log(`\nTarget: lodash@${LODASH}  (CVE-2019-10744, fixed in 4.17.12)\n`);

// 1. UNPROTECTED — the exploit works.
await appHandler(exploit());
line(polluted(), '1. unprotected: exploit pollutes Object.prototype (VULNERABLE)');

// 2. DRY-RUN — detected, logged, NOT enforced (the safe onramp).
{
  const detections = [];
  const p = await createProtection({ rules, mode: 'dry-run', onDetect: (d) => detections.push(d) });
  await p.fetch(appHandler)(exploit());
  const detected = detections.some((d) => d.rule?.id === 'demo-CVE-2019-10744');
  line(detected && polluted(), '2. dry-run: detected + logged, but still served (not enforced)');
}

// 3. BLOCK — request rejected before the sink runs; no pollution.
{
  const p = await createProtection({ rules, mode: 'block' });
  const res = await p.fetch(appHandler)(exploit());
  line(res.status === 403 && !polluted(), '3. block: exploit → 403, sink never runs, prototype clean');
  const benign = await p.fetch(appHandler)(new Request('https://app.demo/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"theme":"dark"}' }));
  line(benign.status === 200, '4. block: benign request still served (200, no false positive)');
}

// 5. RESPONSE leak — an endpoint accidentally returns a key; it's masked, page still served.
{
  const p = await createProtection({ mode: 'block' }); // default response rules
  const leak = () => new Response(JSON.stringify({ ok: true, awsKey: 'AKIAIOSFODNN7EXAMPLE' }), { status: 200, headers: { 'content-type': 'application/json' } });
  const res = await p.fetch(leak)(new Request('https://app.demo/config'));
  const body = await res.text();
  line(res.status === 200 && !body.includes('AKIAIOSFODNN7EXAMPLE') && body.includes('[REDACTED]'), '5. response: leaked AWS key redacted, page still served');
}

// 6. EGRESS SSRF — the app's outbound call to cloud metadata is blocked (stubbed fetch).
{
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => ({ marker: 'stub', url: String(u) });
  const p = await createProtection({ egress: true, mode: 'block' });
  try {
    let blocked = false;
    try { await globalThis.fetch('http://169.254.169.254/latest/meta-data/'); } catch { blocked = true; }
    const ext = await globalThis.fetch('https://api.github.com/');
    line(blocked && ext.marker === 'stub', '6. egress: outbound to 169.254.169.254 blocked, external allowed');
  } finally {
    p.uninstallEgress?.();
    globalThis.fetch = orig;
  }
}

console.log(
  `\n   PROOF: CVE-2019-10744 in lodash@${LODASH} is blocked here, right now, by rule ` +
    `demo-CVE-2019-10744 — until you upgrade to 4.17.12. No app redeploy required.\n`,
);
console.log(ok ? '✓ ALL PASS\n' : '✗ FAILED\n');
process.exit(ok ? 0 : 1);
