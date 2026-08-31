// End-to-end STATIC-RULE-THROUGH-PULSE chain demo for @patchstack/connect/protect.
//
// Unlike demo.mjs (which wires rules from a local file), this proves the real delivery
// path the pilot uses: a rule is served by Pulse over HTTP, fetched by the guard's own
// Pulse client (ETag/conditional-fetch), and enforced in-app — then PROMOTED from dry-run
// to block *remotely* (Pulse flips the bundle's `enforcement`; the guard hot-swaps on
// refresh, no redeploy). The exploit is a REAL unmodified vulnerable dependency
// (lodash@4.17.11, CVE-2019-10744). Public CVE + demo rule only; no tokens/secrets.
//
//   npm install && npm run build   (repo root), then cd examples/protect && npm run setup && node demo-pulse-chain.mjs
import { createServer } from 'node:http';
import { DEMO_TARGET, loadRuntime, requireDemoTarget } from './demo-target.mjs';

const { createProtection } = await loadRuntime();

const _ = await requireDemoTarget();
const LODASH = DEMO_TARGET.version;
const SITE_UUID = '00000000-demo-4pul-se00-000000000001';

let ok = true;
const line = (pass, msg) => { ok = pass && ok; console.log(`  ${pass ? '✓' : '✗'}  ${msg}`); };

// ── The one static rule Pulse will serve (a Step-0 rule: lodash prototype pollution). ──
const lodashRule = {
  id: 'PS-CVE-2019-10744',
  title: 'Prototype pollution in lodash (defaultsDeep / merge / set)',
  vulnerability_id: 'CVE-2019-10744',
  category: 'prototype-pollution',
  rule_v2: [
    { parameter: 'raw', mutations: ['urldecode'], match: { type: 'contains', value: '__proto__' } },
    { parameter: 'rules', rules: [
      { parameter: 'raw', mutations: ['urldecode'], match: { type: 'contains', value: 'constructor' }, inclusive: true },
      { parameter: 'raw', mutations: ['urldecode'], match: { type: 'contains', value: 'prototype' }, inclusive: true },
    ] },
  ],
};

// ── A mock Pulse rules endpoint (GET /rules/{uuid}) with ETag + remote enforcement flip. ──
const pulse = {
  enforcement: 'dry-run',       // what Pulse currently tells the site to do
  etag: '"v1"',
  hits: [],                     // audit of what the guard fetched
};
const server = createServer((req, res) => {
  const m = req.url.match(/^\/rules\/([^/?]+)/);
  if (!m || decodeURIComponent(m[1]) !== SITE_UUID) { res.writeHead(404).end('{}'); return; }
  // Conditional fetch: unchanged bundle → 304 (no body re-sent).
  if (req.headers['if-none-match'] === pulse.etag) {
    pulse.hits.push({ status: 304, etag: pulse.etag });
    res.writeHead(304, { ETag: pulse.etag }).end();
    return;
  }
  const body = JSON.stringify({
    success: true,
    firewall: [lodashRule],
    whitelists: [],
    whitelist_keys: {},
    enforcement: pulse.enforcement,
  });
  pulse.hits.push({ status: 200, etag: pulse.etag, enforcement: pulse.enforcement });
  res.writeHead(200, { 'Content-Type': 'application/json', ETag: pulse.etag }).end(body);
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const PULSE_URL = `http://127.0.0.1:${port}`;

// ── The vulnerable app: "save settings" deep-merges the JSON body via lodash (the sink). ──
const appHandler = async (request) => {
  const body = await request.json().catch(() => ({}));
  _.defaultsDeep({}, body); // CVE-2019-10744 sink
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const exploit = () => new Request('https://app.demo/api/settings', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: '{"constructor":{"prototype":{"polluted":"yes"}}}',
});
const benign = () => new Request('https://app.demo/api/settings', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"theme":"dark"}',
});
const polluted = () => { const hit = ({}).polluted === 'yes'; delete Object.prototype.polluted; return hit; };

console.log(`\nTarget: lodash@${LODASH}  (CVE-2019-10744, fixed in 4.17.12)`);
console.log(`Pulse:  mock rules endpoint at ${PULSE_URL}/rules/${SITE_UUID}\n`);

const detections = [];
// The guard fetches its rules from Pulse by site UUID — the real pilot wiring.
const p = await createProtection({
  siteUuid: SITE_UUID,
  pulseRulesUrl: PULSE_URL,
  onDetect: (d) => detections.push(d),
});

try {
  // 1. The rule arrived over HTTP (not a local file) and the guard is honoring Pulse's dry-run.
  line(pulse.hits.length >= 1 && pulse.hits[0].status === 200, '1. rule fetched from Pulse over HTTP (siteUuid path)');
  line(p.mode === 'dry-run', '2. guard adopted Pulse enforcement = dry-run (safe onramp)');

  // 3. DRY-RUN: the exploit is DETECTED + logged, but still served → app stays vulnerable.
  await p.fetch(appHandler)(exploit());
  const detected = detections.some((d) => d.rule?.id === 'PS-CVE-2019-10744');
  line(detected && polluted(), '3. dry-run: exploit detected + logged, but served (still vulnerable)');

  // 4. REMOTE PROMOTION: Pulse flips the bundle to block (new ETag). No app redeploy.
  pulse.enforcement = 'block';
  pulse.etag = '"v2"';
  await p.refresh(); // one manual refresh tick (the poll loop / push endpoint drive the same tick)
  line(p.mode === 'block', '4. remote promotion: Pulse flipped dry-run → block, guard hot-swapped');

  // 5. BLOCK: replay the SAME exploit → rejected before the sink runs; prototype stays clean.
  const blockedRes = await p.fetch(appHandler)(exploit());
  line(blockedRes.status === 403 && !polluted(), '5. block: SAME exploit → 403, sink never runs, prototype clean');

  // 6. Benign request still served — no false positive.
  const benignRes = await p.fetch(appHandler)(benign());
  line(benignRes.status === 200, '6. block: benign request still served (200, no false positive)');

  // 7. ETag conditional fetch: an unchanged refresh revalidates as 304 (no body re-sent).
  const before = pulse.hits.length;
  await p.refresh();
  const last = pulse.hits[pulse.hits.length - 1];
  line(pulse.hits.length === before + 1 && last.status === 304, '7. refresh with no change → 304 Not Modified (conditional fetch)');

  console.log(
    `\n   PROOF: CVE-2019-10744 in lodash@${LODASH} was shielded via a rule delivered by Pulse, ` +
    `then\n   promoted dry-run → block remotely and re-verified against the same exploit — ` +
    `no app\n   redeploy. This is the pilot's static-rule delivery + promotion chain, end to end.\n`,
  );
  console.log(ok ? '✓ ALL PASS\n' : '✗ FAILED\n');
} finally {
  p.stopRefresh?.();
  await new Promise((r) => server.close(r));
}
process.exit(ok ? 0 : 1);
