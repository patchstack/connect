import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * The egress phase, rule by rule.
 *
 * Each rule is evaluated independently, every match is reported under its own rule, and the call is
 * blocked when any matching rule enforces — whatever else matched, and in whatever order the rules are
 * given.
 *
 * An enforcing rule and an observing rule that match the same call are both reported. The two events
 * are per-rule evidence about one outbound attempt, and their modes are what distinguish an attempt
 * that was prevented from one a rule would have prevented.
 */
const internalHost = [{ parameter: 'egress.host', match: { type: 'internal_host' } }];

/** An enforcing rule and an observing rule that match the same thing. */
const overlapping = () => [
  { id: 'enforcing-internal-address', category: 'ssrf', rule_v2: internalHost },
  { id: 'observing-internal-address', category: 'ssrf', enforcement: 'dry-run', rule_v2: internalHost },
];

async function withEgress(
  opts: any,
  fn: (events: any[]) => Promise<void>,
): Promise<void> {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('stub')) as any;
  const events: any[] = [];
  const p: any = await createProtection({
    egress: true,
    mode: 'block',
    onDetect: (event: unknown) => events.push(event),
    ...opts,
  });
  try {
    await fn(events);
  } finally {
    p.uninstallEgress?.();
    globalThis.fetch = origFetch;
  }
}

describe('two rules matching one call', () => {
  it('reports both', async () => {
    await withEgress({ egressRules: overlapping() }, async (events) => {
      await expect(globalThis.fetch('http://127.0.0.1/admin')).rejects.toThrow();

      expect(events.map((e) => e.rule?.id)).toEqual([
        'enforcing-internal-address',
        'observing-internal-address',
      ]);
    });
  });

  it('reports each with its own mode', async () => {
    // One event says the attempt was prevented, the other that a rule would have prevented it. Without
    // the modes the two are indistinguishable.
    await withEgress({ egressRules: overlapping() }, async (events) => {
      await expect(globalThis.fetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();

      expect(events.find((e) => e.rule?.id === 'enforcing-internal-address')?.mode).toBe('block');
      expect(events.find((e) => e.rule?.id === 'observing-internal-address')?.mode).toBe('dry-run');
    });
  });

  it('blocks whichever order the rules are given in', async () => {
    // Enforcement is a property of the rules that matched, not of their position in the list.
    await withEgress({ egressRules: overlapping().reverse() }, async (events) => {
      await expect(globalThis.fetch('http://127.0.0.1/admin')).rejects.toThrow();

      expect(events).toHaveLength(2);
    });
  });
});

describe('calls no rule enforces on', () => {
  it('lets through and reports nothing when no rule matches', async () => {
    await withEgress({ egressRules: overlapping() }, async (events) => {
      // An address literal, and a public one. A name would have to resolve, and a name that cannot be
      // resolved is screened as internal — fail-closed, and nothing to do with what these rules match.
      const res = await globalThis.fetch('http://93.184.216.34/api');

      expect(await res.text()).toBe('stub');
      expect(events).toHaveLength(0);
    });
  });

  it('reports without blocking when every matching rule observes', async () => {
    const observing = [
      { id: 'observing-internal-address', category: 'ssrf', enforcement: 'dry-run', rule_v2: internalHost },
    ];

    await withEgress({ egressRules: observing }, async (events) => {
      // Allowed through to the stub: an observing rule records the attempt and prevents nothing.
      const res = await globalThis.fetch('http://127.0.0.1/admin');

      expect(await res.text()).toBe('stub');
      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('dry-run');
    });
  });

  it('reports nothing for a host the caller allowed', async () => {
    await withEgress({ egressRules: overlapping(), allowHosts: ['127.0.0.1'] }, async (events) => {
      const res = await globalThis.fetch('http://127.0.0.1/admin');

      expect(await res.text()).toBe('stub');
      expect(events).toHaveLength(0);
    });
  });
});
