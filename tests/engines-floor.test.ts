import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { floorOf } from '../scripts/engines-floor.mjs';

/**
 * The version CI installs to test what `engines.node` claims.
 *
 * Read from the manifest rather than written down anywhere else: a floor tested on a version somebody
 * typed is a floor that stops being tested the moment the claim moves.
 */
describe('the exact version a `>=` floor admits', () => {
  for (const [range, floor] of [
    ['>=20', '20.0.0'],
    ['>=20.19', '20.19.0'],
    ['>=20.19.4', '20.19.4'],
    ['>=21', '21.0.0'],
    ['>= 22', '22.0.0'],
  ] as const) {
    it(`${range} -> ${floor}`, () => {
      expect(floorOf(range)).toBe(floor);
    });
  }

  // Refused rather than guessed: each of these has a lowest admitted version that is not what a naive
  // read of the leading number would say, and CI must not run on a number nobody stated.
  for (const range of ['^20', '~20.19', '>=20 <22', '20.x', '*', '>=20 || >=22', '', undefined]) {
    it(`refuses ${JSON.stringify(range)}`, () => {
      expect(() => floorOf(range as never)).toThrow();
    });
  }

  it('prints the floor THIS manifest declares, which is what CI installs', () => {
    // The one assertion that binds the workflow's input to the claim. Printing some version proves the
    // script runs; printing the version this manifest admits is what makes the job test the floor
    // rather than a number that happens to be written somewhere. A value hard-coded in the script, or a
    // manifest whose range this cannot read, fails here rather than in a workflow log.
    const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines?.node;
    const printed = execFileSync(process.execPath, ['scripts/engines-floor.mjs'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    }).trim();

    expect(printed).toBe(floorOf(declared));
  });
});
