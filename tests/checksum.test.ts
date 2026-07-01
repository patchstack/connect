import { describe, expect, it } from 'vitest';
import { computeManifestChecksum } from '../src/checksum.js';

// The expected values below are cross-checked byte-for-byte against the server
// algorithm in PulseController::storeManifest:
//   substr(hash('sha256', json_encode($sortedPackages, JSON_UNESCAPED_SLASHES)), 0, 12)
describe('computeManifestChecksum', () => {
  it('matches the server checksum for a single package', () => {
    expect(computeManifestChecksum([{ name: 'lodash', version: '4.17.21' }])).toBe('705680d827bc');
  });

  it('matches the server for scoped names and multiple packages', () => {
    expect(
      computeManifestChecksum([
        { name: '@babel/core', version: '7.0.0' },
        { name: 'axios', version: '1.6.0' },
      ]),
    ).toBe('a828c5c61d95');
  });

  it('sorts versions lexicographically like the server (1.10.0 before 1.9.0), not semver', () => {
    const ascending = computeManifestChecksum([
      { name: 'foo', version: '1.9.0' },
      { name: 'foo', version: '1.10.0' },
    ]);
    const descending = computeManifestChecksum([
      { name: 'foo', version: '1.10.0' },
      { name: 'foo', version: '1.9.0' },
    ]);
    expect(ascending).toBe('ba8275c7b0ab');
    expect(descending).toBe('ba8275c7b0ab');
  });

  it('is stable regardless of input order', () => {
    expect(
      computeManifestChecksum([
        { name: 'axios', version: '1.6.0' },
        { name: '@babel/core', version: '7.0.0' },
      ]),
    ).toBe('a828c5c61d95');
  });
});
