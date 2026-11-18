import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

assert.equal(process.env.PS_FASTIFY_LIVE, '1');
assert.equal(process.platform, 'linux');
assert.equal(process.env.NODE_OPTIONS, undefined);
const deployment = JSON.parse(readFileSync(process.env.PATCHSTACK_DEPLOYMENT_FILE, 'utf8'));
const { protection } = await import('@patchstack/connect/register');
const expectMatch = process.env.PS_FASTIFY_EXPECT_MATCH === '1';
const deadline = Date.now() + 20_000;
while (expectMatch && !protection.synchronization.matched && Date.now() < deadline) {
  await new Promise(done => setTimeout(done, 1000));
  if (Date.now() < deadline) await protection.refresh();
}
const status = protection.synchronization;
assert.equal(status.source.origin, 'api');
assert.equal(status.source.ok, true);
assert.equal(status.siteUuid, deployment.siteUuid);
assert.equal(status.buildId, deployment.buildId);
assert.equal(status.matched, expectMatch);
const { bundle } = JSON.parse(readFileSync('.patchstack/patchstack-rules.json', 'utf8'));
const scopedRule = process.env.PS_FASTIFY_SCOPE_RULE;
if (scopedRule) {
  const outcome = process.env.PS_FASTIFY_SCOPE_EXPECT;
  const served = bundle.firewall.find(rule => String(rule.id) === scopedRule);
  const active = protection.rules.request.find(rule => String(rule.id) === scopedRule);
  if (outcome === 'absent') {
    assert.equal(served, undefined, 'The scoped lookup should omit the other build’s rule.');
    assert.equal(active, undefined);
  } else {
    assert.ok(served && /^[a-f0-9]{64}$/.test(served.build_scope), 'SaaS did not serve the dedicated build-scoped rule.');
    assert.equal(served.build_scope === deployment.buildId, outcome === 'block');
    assert.ok(active, 'The guard did not load the dedicated rule.');
    assert.equal(active.enforcement === 'dry-run', outcome === 'detect');
  }
  process.once('SIGTERM', async () => {
    await protection.stop();
    process.exit(0);
  });
}
console.log('Fastify live pilot ' + JSON.stringify({
  matched: status.matched, mapRules: status.mapRules, delivered: bundle.firewall.length,
  scoped: status.rules.scoped, scopedBlocking: status.rules.scopedBlocking,
}));
