import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFastifyHook } from './preload.mjs';

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
console.log('Fastify live pilot ' + JSON.stringify({
  matched: status.matched, mapRules: status.mapRules, delivered: bundle.firewall.length,
  scoped: status.rules.scoped, scopedBlocking: status.rules.scopedBlocking,
}));
installFastifyHook(protection);
