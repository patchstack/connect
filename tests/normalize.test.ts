import { describe, expect, it } from 'vitest';
import { buildWirePayload, compareVersions } from '../src/normalize.js';
import type { Manifest } from '../src/types.js';

describe('compareVersions', () => {
  it('handles semantic version ordering', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('orders minor and patch numerically, not lexicographically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
  });

  it('treats prereleases as lower than the release', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-alpha')).toBeGreaterThan(0);
  });

  it('strips leading v', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });
});

describe('buildWirePayload', () => {
  it('emits every unique (name, version) pair, preserving duplicates by name', () => {
    const manifest: Manifest = {
      ecosystem: 'npm',
      packages: [
        { name: 'lodash', version: '4.17.21' },
        { name: 'lodash', version: '4.17.15' },
        { name: 'axios', version: '1.6.0' },
      ],
    };
    const { payload, stats } = buildWirePayload(manifest);

    expect(payload.packages).toEqual([
      { name: 'axios', version: '1.6.0' },
      { name: 'lodash', version: '4.17.15' },
      { name: 'lodash', version: '4.17.21' },
    ]);
    expect(stats.duplicateNames).toEqual(['lodash']);
    expect(stats.uniqueNames).toBe(2);
    expect(stats.totalEntries).toBe(3);
  });

  it('de-duplicates exact (name, version) repeats', () => {
    const manifest: Manifest = {
      ecosystem: 'npm',
      packages: [
        { name: 'lodash', version: '4.17.21' },
        { name: 'lodash', version: '4.17.21' },
      ],
    };
    const { payload } = buildWirePayload(manifest);
    expect(payload.packages).toEqual([{ name: 'lodash', version: '4.17.21' }]);
  });

  it('sorts output by name then version', () => {
    const manifest: Manifest = {
      ecosystem: 'npm',
      packages: [
        { name: 'zeta', version: '1.0.0' },
        { name: 'alpha', version: '2.0.0' },
        { name: 'alpha', version: '1.10.0' },
        { name: 'alpha', version: '1.9.0' },
      ],
    };
    const { payload } = buildWirePayload(manifest);
    expect(payload.packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      'alpha@1.9.0',
      'alpha@1.10.0',
      'alpha@2.0.0',
      'zeta@1.0.0',
    ]);
  });

  it('preserves ecosystem on output', () => {
    const manifest: Manifest = { ecosystem: 'npm', packages: [{ name: 'a', version: '1.0.0' }] };
    expect(buildWirePayload(manifest).payload.ecosystem).toBe('npm');
  });

  it('produces an empty packages array when no entries exist', () => {
    const manifest: Manifest = { ecosystem: 'npm', packages: [] };
    const { payload, stats } = buildWirePayload(manifest);
    expect(payload.packages).toEqual([]);
    expect(stats.uniqueNames).toBe(0);
  });
});
