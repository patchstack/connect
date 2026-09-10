// The canonical identity carried between an uploaded map, a bundled stamp, and a rule scope.
//
// The negatives carry the weight, because the failure is silent: an identity the other end cannot match
// leaves every build-scoped rule detecting and nothing reporting a fault. So the cases that matter are
// the ones where an identity must NOT be produced — an abbreviation that could never compare equal, a
// value that cannot survive an HTTP header, and two variables that disagree.
//
import { describe, expect, it } from 'vitest';

import { canonicalBuildId, hasRawBuildStamp, readBuildStamp } from '../src/build-id.js';

const SHA = 'b'.repeat(64);

/** Built from character codes so this source file carries no control character of its own. */
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);

describe('the canonical form of an identity', () => {
  it('is a complete 64-hex SHA-256 identity, lowercased', () => {
    expect(canonicalBuildId(SHA.toUpperCase())).toBe(SHA);
    expect(canonicalBuildId(`  ${SHA}\n`)).toBe(SHA);
  });

  it('refuses a shortened value, which cannot compare equal to the complete identity', () => {
    expect(canonicalBuildId('deadbee')).toBeNull();
    expect(canonicalBuildId('a'.repeat(40))).toBeNull();
    expect(canonicalBuildId(SHA.slice(0, 12))).toBeNull();
    expect(canonicalBuildId(`${SHA}a`)).toBeNull();
  });

  it('refuses anything that could not survive an HTTP header', () => {
    // The value is carried in a request header, where a line break is a header-splitting attempt and a
    // control character makes `Headers` throw.
    expect(canonicalBuildId(`${SHA}${CRLF}X-Injected: 1`)).toBeNull();
    expect(canonicalBuildId(`${SHA.slice(0, 20)} ${SHA.slice(20)}`)).toBeNull();
    expect(canonicalBuildId('build-2026-09-10-01')).toBeNull();
    expect(canonicalBuildId('café'.padEnd(40, 'a'))).toBeNull();
  });

  it('refuses a non-string', () => {
    for (const value of [undefined, null, 42, {}, [SHA]]) expect(canonicalBuildId(value)).toBeNull();
  });
});

describe('reading a stamp out of a bundle', () => {
  const SHA = 'a'.repeat(64);

  it('reads a canonical stamp', () => {
    expect(readBuildStamp({ _patchstack: { build_id: SHA.toUpperCase() } })).toBe(SHA);
  });

  it('reads a malformed stamp as absent, but still sees the raw property', () => {
    // Two different questions. Enforcement needs a value it can compare, so a malformed one is no
    // identity at all. Clearing needs to know the property is THERE, or a stamp this build did not earn
    // survives into the bundled guard.
    const bundle = { _patchstack: { build_id: 'deadbee' } };
    expect(readBuildStamp(bundle)).toBeNull();
    expect(hasRawBuildStamp(bundle)).toBe(true);
  });

  it('answers for a bundle with no stamp at all', () => {
    for (const bundle of [{}, { _patchstack: {} }, { _patchstack: null }, null, undefined, 'x']) {
      expect(readBuildStamp(bundle)).toBeNull();
    }
    expect(hasRawBuildStamp({})).toBe(false);
    expect(hasRawBuildStamp({ _patchstack: {} })).toBe(false);
  });
});
