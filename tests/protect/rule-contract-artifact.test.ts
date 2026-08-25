import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ruleContract } from '../../src/protect/rules/contract.js';

/**
 * The published contract must be the source's contract.
 *
 * `rule-contract.json` is vendored by the layers that author and forward rule documents. A committed
 * artifact that has drifted from the code is worse than no artifact: every consumer agrees with each other
 * and none of them agrees with the engine, so a rule they all accept is one the engine cannot run.
 */
describe('the committed rule contract', () => {
  it('matches what the source produces', () => {
    const committed = JSON.parse(readFileSync(new URL('../../rule-contract.json', import.meta.url), 'utf8'));
    const { $comment, ...published } = committed;

    expect($comment, 'the artifact should say it is generated').toContain('Do not edit');
    expect(published).toEqual(ruleContract());
  });

  it('fails its own check command when stale', () => {
    // The check the repo runs. Asserted by running it, because a drift guard nobody invokes is a guard that
    // reports nothing — and this one exists precisely to be invoked by CI.
    // `process.execPath`, not the string "node": the test runner's PATH need not contain a `node` binary,
    // and a spawn that fails to find one would fail this test for a reason unrelated to drift.
    const output = execFileSync(process.execPath, ['scripts/emit-rule-contract.mjs', '--check'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
    });

    expect(output).toContain('up to date');
  });
});
