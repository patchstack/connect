import { describe, expect, it } from 'vitest';
import { matchValue, RuleEngine } from '../../src/protect/engine/engine.js';
import { fromFetchRequest } from '../../src/protect/engine/fetch.js';

// `internal_host` classifies the host a value names. A URL parser resolves a host from more spellings
// than `scheme://host`, so each of those has to be read the same way.

describe('internal_host on URL spellings a parser resolves to a host', () => {
  it.each([
    'http:/169.254.169.254/latest',
    'http:\\\\169.254.169.254/latest',
    'HTTP:169.254.169.254',
    'http:127.0.0.1',
    'https:/\\127.0.0.1',
    'ws:127.0.0.1',
    'ftp:127.0.0.1',
    '\\\\127.0.0.1/path',
    '/\\127.0.0.1/path',
    '\\/127.0.0.1/path',
    'ht\ttp://127.0.0.1/',
    'http://127.0.0.1\n/',
    '\u0000http://127.0.0.1/',
  ])('classifies %j as internal', (value) => {
    expect(new URL(value, 'https://app.test/').hostname).toMatch(/^(127\.0\.0\.1|169\.254\.169\.254)$/);
    expect(matchValue('internal_host', value, null)).toBe(true);
  });

  it.each([
    'http:/example.test/',
    'HTTPS:example.test',
    '\\\\example.test/path',
    'mailto:someone@127.0.0.1',
    'localhost-docs.example.test',
  ])('does not classify %j as internal', (value) => {
    expect(matchValue('internal_host', value, null)).toBe(false);
  });

  it('keeps reading a host:port pair as a host', () => {
    expect(matchValue('internal_host', 'localhost:8080', null)).toBe(true);
    expect(matchValue('internal_host', 'example.test:8080', null)).toBe(false);
  });

  it('trims a long value in linear time', () => {
    const value = 'a' + ' '.repeat(200_000) + 'b';
    const started = performance.now();
    expect(matchValue('internal_host', value, null)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('blocks a request parameter written in a short spelling', async () => {
    const engine = new RuleEngine({
      firewall: [{ id: 1, title: 'internal target', rule_v2: [{ parameter: 'get.target', match: { type: 'internal_host' } }] }],
      whitelists: [],
      whitelist_keys: {},
    } as any);
    const blocked = async (target: string) =>
      engine.evaluate(await fromFetchRequest(new Request('https://app.test/?target=' + encodeURIComponent(target)))).blocked;

    expect(await blocked('http:/169.254.169.254/latest')).toBe(true);
    expect(await blocked('http:/example.test/')).toBe(false);
  });
});
