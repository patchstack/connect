import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { PHASES } from '../../src/protect/rules/contract.js';

/**
 * The class on a detection: top-level `category`, taken from the rule that matched.
 *
 * A declared field of the `onDetect` payload, and a duplicate one — the same class is reachable through
 * `rule.category`, which is what the platform reporter reads. So what is pinned here is the declared
 * payload, not whether a detection can be classified: each phase copies the top-level field from its own
 * rule, and a consumer reading it must not find a class in one phase and nothing in another.
 *
 * One case per phase, checked against the contract's own list rather than a list written here, so a
 * phase added later arrives with no case and says so.
 */
type Detection = { phase?: string; category?: string };
type Raise = (onDetect: (detection: Detection) => void) => Promise<void>;

const bundle = (...firewall: unknown[]) => ({ firewall, whitelists: [], whitelist_keys: {} });
const serve = () => new Response('ok', { status: 200 });

// A different class in every phase, so a payload naming a constant, or another phase's rule, fails.
const CASES: Array<{ phase: string; category: string; raise: Raise }> = [
  {
    phase: 'request',
    category: 'injection',
    raise: async (onDetect) => {
      const protection = await createProtection({
        rules: bundle({
          id: 'cat-request',
          title: 'a request rule that declares its class',
          category: 'injection',
          rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'union select' } }],
        }),
        mode: 'dry-run',
        onDetect,
      });

      await protection.fetch(serve)(new Request('https://app.example.com/search?q=union%20select%201'));
    },
  },
  {
    phase: 'response',
    category: 'secret-exposure',
    raise: async (onDetect) => {
      const protection: any = await createProtection({
        rules: bundle(),
        responseRules: [{
          id: 'cat-response',
          phase: 'response',
          category: 'secret-exposure',
          action: 'redact',
          rule_v2: [{ parameter: 'response.body', match: { type: 'contains', value: 'sk_live_' } }],
        }],
        mode: 'dry-run',
        onDetect,
      });

      await protection.screenResponse(
        new Response(JSON.stringify({ token: 'sk_live_abcdef' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  },
  {
    phase: 'egress',
    category: 'ssrf',
    raise: async (onDetect) => {
      // Egress screening wraps the global fetch, so the call has to be made through it.
      const original = globalThis.fetch;
      globalThis.fetch = (async () => ({ marker: 'stub' })) as any;
      const protection: any = await createProtection({
        egress: true,
        mode: 'dry-run',
        egressRules: [{
          id: 'cat-egress',
          phase: 'egress',
          category: 'ssrf',
          rule_v2: [{ parameter: 'egress.host', match: { type: 'contains', value: 'evil.com' } }],
        }],
        onDetect,
      });
      try {
        await (globalThis.fetch as any)('https://api.evil.com/x');
      } finally {
        protection.uninstallEgress?.();
        globalThis.fetch = original;
      }
    },
  },
];

describe('what a detection says the rule was for', () => {
  it('has a case for every phase a rule can carry', () => {
    expect([...CASES].map((one) => one.phase).sort()).toEqual([...PHASES].sort());
  });

  for (const { phase, category, raise } of CASES) {
    it(`names the rule's own class on a ${phase}-phase detection`, async () => {
      const detections: Detection[] = [];
      await raise((detection) => detections.push(detection));

      expect(detections).toHaveLength(1);
      expect(detections[0].phase).toBe(phase);
      expect(detections[0].category).toBe(category);
    });
  }
});
