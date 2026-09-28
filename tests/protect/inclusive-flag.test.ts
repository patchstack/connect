import { describe, expect, it } from 'vitest';
import { validateBundle } from '../../src/protect/rules/validate.js';

// `inclusive` decides whether a condition is ANDed with its siblings or ORed. Only a boolean is accepted,
// because anything else would be read for its truthiness rather than for what it says.

const condition = (inclusive: unknown) => ({ parameter: 'get.q', inclusive, match: { type: 'contains', value: 'x' } });
const rule = (conditions: unknown[]) => ({ id: 'r1', rule_v2: conditions });

describe('the inclusive flag', () => {
  it.each([true, false])('accepts %s', (inclusive) => {
    const { rejected } = validateBundle({ firewall: [rule([condition(inclusive), condition(inclusive)])], whitelists: [] } as any);
    expect(rejected).toEqual([]);
  });

  it('accepts a condition without it', () => {
    const { rejected } = validateBundle({ firewall: [rule([{ parameter: 'get.q', match: { type: 'contains', value: 'x' } }])], whitelists: [] } as any);
    expect(rejected).toEqual([]);
  });

  it.each(['false', 'true', 0, 1, null, {}])('rejects %j with a reason', (inclusive) => {
    const { bundle, rejected } = validateBundle({ firewall: [rule([condition(inclusive)])], whitelists: [] } as any);
    expect(bundle.firewall).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/inclusive must be true or false/);
  });

  it('rejects it inside a group too', () => {
    const grouped = rule([{ parameter: 'rules', rules: [condition('false')] }]);
    const { rejected } = validateBundle({ firewall: [grouped], whitelists: [] } as any);
    expect(rejected[0].reason).toMatch(/inclusive must be true or false/);
  });
});
