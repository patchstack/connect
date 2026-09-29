import { describe, expect, it } from 'vitest';
import { validateBundle } from '../../src/protect/rules/validate.js';
import { parameterProblem } from '../../src/protect/rules/contract.js';

// Every member of a parameter list is held to the same rule as a single parameter. An absent parameter is
// allowed only for a whole condition (a match type that reads the whole request carries none).

const MATCH = { type: 'contains', value: 'x' };
const rule = (condition: Record<string, unknown>) => ({ id: 'r1', rule_v2: [condition] });
const rejectedReason = (condition: Record<string, unknown>) =>
  validateBundle({ firewall: [rule(condition)], whitelists: [] }).rejected[0]?.reason;

describe('parameter list members', () => {
  it.each([
    ['[null]', [null]],
    ['[undefined]', [undefined]],
    ['a header list with null', ['response.header.x-sample', null]],
    ['a body list with undefined', ['response.body', undefined]],
    ['a number', ['post.field', 1]],
    ['an object', ['post.field', { name: 'post.other' }]],
    ['an empty string', ['post.field', '']],
    ['a keyless source that needs a key', ['get']],
    ['an unknown key', ['server.NOT_A_KEY']],
    ['an unknown source', ['nowhere.field']],
  ])('refuses %s', (_label, parameter) => {
    expect(parameterProblem(parameter)).not.toBeNull();
    expect(rejectedReason({ parameter, match: MATCH })).toBeDefined();
  });

  it('names what is wrong with an absent member', () => {
    expect(parameterProblem(['post.field', null])).toBe('parameter list members must be non-empty strings');
  });

  it('refuses an absent member inside a nested group', () => {
    const nested = { parameter: 'rules', rules: [{ parameter: 'rules', rules: [{ parameter: ['post.field', null], match: MATCH }] }] };
    expect(rejectedReason(nested)).toBe('parameter list members must be non-empty strings');
  });

  it.each([
    ['one member', ['post.field']],
    ['several members', ['post.field', 'get.q', 'response.header.x-sample', 'response.body']],
  ])('accepts a list of %s', (_label, parameter) => {
    expect(parameterProblem(parameter)).toBeNull();
    expect(rejectedReason({ parameter, match: MATCH })).toBeUndefined();
  });

  it('still allows a whole condition without a parameter where the match type takes none', () => {
    expect(parameterProblem(null)).toBeNull();
    expect(parameterProblem(undefined)).toBeNull();
  });
});
