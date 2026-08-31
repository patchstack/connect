import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateBundle } from '../src/protect/rules/validate.js';

/**
 * The demo rule bundles: every rule is enforceable, and every rule discriminates.
 *
 * Two independent properties, and a rule can satisfy one while failing the other. A bundle the contract
 * refuses is dropped at load, so the demo runs with fewer rules than it appears to and still reports
 * success — the engine says so in its output, which nothing reads. And a rule that loads may still match
 * nothing, or match everything.
 *
 * The demos themselves only exercise the lodash rule, so without this the other rules in these bundles
 * have no coverage at all.
 */
const root = new URL('../', import.meta.url);
const bundlePath = (name: string) => fileURLToPath(new URL(`examples/protect/${name}`, root));
const load = (name: string) => JSON.parse(readFileSync(bundlePath(name), 'utf8'));

const BUNDLES = ['rules.demo.json', 'demo-rules.json'].filter((n) => existsSync(bundlePath(n)));

describe('demo rule bundles pass the contract that gates delivered rules', () => {
  it('has bundles to check', () => {
    expect(BUNDLES.length).toBeGreaterThan(0);
  });

  it.each(BUNDLES)('%s: the contract rejects nothing', (name) => {
    // `validateBundle` is the same gate a delivered bundle goes through, so this is the real answer to
    // "would this rule be enforced" rather than a re-implementation of the rules for the parameter names.
    const { bundle, rejected } = validateBundle(load(name));
    const declared = (load(name).firewall ?? []).length;

    expect(rejected.map((r) => `${r.id}: ${r.reason}`)).toEqual([]);
    // And the surviving count equals the declared count, so a rule silently dropped for any other reason
    // is caught too.
    expect(bundle.firewall).toHaveLength(declared);
  });
});

/**
 * One exploit and one benign control per rule.
 *
 * The benign half is what makes each case evidence: a rule that blocks its exploit and everything else
 * has not been shown to discriminate, and a demo bundle is exactly where an over-broad rule looks fine.
 */
type Case = { rule: string; exploit: Request; benign: Request };

const ORIGIN = 'https://demo.test';
const post = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const CASES: Case[] = [
  {
    rule: 'demo-CVE-2019-10744 (prototype pollution)',
    exploit: post('/settings', { constructor: { prototype: { polluted: true } } }),
    benign: post('/settings', { theme: 'dark', locale: 'en-GB' }),
  },
  {
    rule: 'demo-path-traversal',
    exploit: new Request(`${ORIGIN}/download?file=..%2F..%2Fetc%2Fpasswd`),
    benign: new Request(`${ORIGIN}/download?file=quarterly-report.pdf`),
  },
  {
    rule: 'demo-ssrf-url-param',
    exploit: new Request(`${ORIGIN}/fetch?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F`),
    benign: new Request(`${ORIGIN}/fetch?url=https%3A%2F%2Fexample.com%2Flogo.png`),
  },
];

describe('every rule in the demo bundle discriminates', () => {
  // Against the built engine, since that is what the demos load. `dist/` is gitignored, so a plain
  // checkout has nothing to run; CI builds before it tests.
  const enginePath = fileURLToPath(new URL('dist/protect.js', root));
  const built = existsSync(enginePath);

  it('has an engine to test against, or is honest that it did not run', () => {
    expect(BUNDLES).toContain('rules.demo.json');
  });

  describe.skipIf(!built)('with the built engine', () => {
    it.each(CASES)('$rule blocks its exploit and allows its control', async ({ rule, exploit, benign }) => {
      const { createProtection } = await import(/* @vite-ignore */ enginePath);
      const protection: any = await createProtection({ rules: load('rules.demo.json'), mode: 'block' });
      const guard = protection.fetchGuard();

      const blockedExploit = await guard(exploit);
      const blockedBenign = await guard(benign);

      expect({
        exploit: blockedExploit?.status ?? 'allowed',
        benign: blockedBenign?.status ?? 'allowed',
      }, rule).toEqual({ exploit: 403, benign: 'allowed' });
    });
  });
});
