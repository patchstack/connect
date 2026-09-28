import { describe, expect, it } from 'vitest';
import { _testExports } from '../../src/protect/engine/engine.js';

const { isInternalHost, matchValue } = _testExports as {
  isInternalHost: (host: string) => boolean;
  matchValue: (type: string, value: string, expected: unknown) => boolean;
};

// Each non-public range, next to the closest public neighbour, so a boundary that is off by one
// in either direction fails a case.
describe('internal_host classifies non-public address space', () => {
  it.each([
    ['198.18.0.1', '198.17.255.255'],
    ['198.19.255.254', '198.20.0.1'],
    ['192.0.0.170', '192.0.1.1'],
    ['224.0.0.251', '223.255.255.255'],
    ['239.255.255.250', '223.1.1.1'],
    ['240.0.0.1', '223.255.255.254'],
    ['255.255.255.255', '8.8.8.8'],
  ])('IPv4 %s is internal, %s is not', (internal, external) => {
    expect(isInternalHost(internal)).toBe(true);
    expect(isInternalHost(external)).toBe(false);
  });

  it.each([
    ['fec0::1', 'fe00::1'],
    ['feff::1', 'fe7f::1'],
    ['ff02::1', 'fe7f:ffff::1'],
    ['64:ff9b::a9fe:a9fe', '64:ff9b::808:808'],
    ['64:ff9b::10.0.0.1', '64:ff9b::1.1.1.1'],
    ['64:ff9b:1::1', '64:ff9c::a9fe:a9fe'],
    ['2002:7f00:1::', '2002:808:808::'],
    ['2002:c0a8:101::1', '2003:c0a8:101::1'],
    ['[2002:a9fe:a9fe::]', '[2002:0101:0101::]'],
  ])('IPv6 %s is internal, %s is not', (internal, external) => {
    expect(isInternalHost(internal)).toBe(true);
    expect(isInternalHost(external)).toBe(false);
  });

  it('applies to a full URL parameter on the request phase', () => {
    expect(matchValue('internal_host', 'http://[64:ff9b::a9fe:a9fe]/latest/', null)).toBe(true);
    expect(matchValue('internal_host', 'http://198.18.0.1:8080/', null)).toBe(true);
    expect(matchValue('internal_host', 'http://[64:ff9b::808:808]/', null)).toBe(false);
  });
});
