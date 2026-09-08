import { describe, it, expect, afterEach } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

/**
 * What the guard does with an option that has to be a list and is not one.
 *
 * It builds, it reports the option by name, and it screens exactly as it would with the option absent.
 * Three of `createProtection`'s options are lists: `responseRules`, `egressRules`, `allowHosts`.
 *
 * Asserted shape by shape — a string, a number, an object, `null` — because the outcome has to be the
 * same for every one of them, and each of those is a plausible thing to write. `undefined` is the only
 * value that means "absent"; the rest are values someone wrote, and a value someone wrote is either
 * used or reported.
 *
 * Ignored rather than adapted, and reported by name: "the host you named is allowed" and "no host is
 * allowed" are different policies, and choosing between them is not this code's to make.
 */
// The string and the object name the very host these tests then try to reach, so a value adapted into a
// one-element list — rather than dropped — shows up as that host becoming reachable.
const WRONG_SHAPES: Array<[string, unknown]> = [
  ['a string', '169.254.169.254'],
  ['a number', 7],
  ['an object', { 0: '169.254.169.254' }],
  // Declared as a list or nothing, so `null` is neither: it is a value, and it is reported like one.
  ['null', null],
];

const INTERNAL = 'http://169.254.169.254/latest/meta-data/';
const stubbed: Array<() => void> = [];
const built: Array<{ uninstallEgress?: () => void; stop?: () => Promise<void> | void }> = [];

afterEach(async () => {
  for (const restore of stubbed.splice(0)) restore();
  for (const protection of built.splice(0)) {
    protection.uninstallEgress?.();
    // Awaited: `stop()` is a completion contract, and a reporter still running is one that reports into
    // whichever case comes next.
    await protection.stop?.();
  }
});

function stubFetch(): void {
  const original = globalThis.fetch;
  stubbed.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async () => new Response('reached')) as never;
}

/** Whether the guard let an outbound call to a link-local address through. */
async function reachesInternalHost(options: Record<string, unknown>): Promise<{ reached: boolean; reported: string[] }> {
  const reported: string[] = [];
  stubFetch();
  const protection: any = await createProtection({
    egress: true,
    mode: 'block',
    rules: { firewall: [], whitelists: [] },
    onError: (err: Error) => reported.push(String(err.message)),
    ...options,
  });
  built.push(protection);

  try {
    await globalThis.fetch(INTERNAL);

    return { reached: true, reported };
  } catch {
    return { reached: false, reported };
  }
}

describe('a list option that is not a list', () => {
  for (const [shape, value] of WRONG_SHAPES) {
    it(`is reported and dropped when \`allowHosts\` is ${shape}`, async () => {
      const { reached, reported } = await reachesInternalHost({ allowHosts: value });

      // Allowing nothing: a value that is not a list names no host.
      expect(reached, 'an unparseable allowlist allows nothing').toBe(false);
      expect(reported.join(' ')).toContain('allowHosts');
    });

    it(`is reported and dropped when \`egressRules\` is ${shape}`, async () => {
      const { reached, reported } = await reachesInternalHost({ egressRules: value });

      // The engine's own egress policy applies, as it does when the option is absent — the phase carries
      // the compiled policy and not whatever the value could be read as.
      expect(reached, 'the compiled egress policy still screens').toBe(false);
      expect(reported.join(' ')).toContain('egressRules');
    });

    it(`is reported and dropped when \`responseRules\` is ${shape}`, async () => {
      const reported: string[] = [];
      const protection: any = await createProtection({
        mode: 'block',
        rules: { firewall: [], whitelists: [] },
        responseRules: value,
        onError: (err: Error) => reported.push(String(err.message)),
      });
      built.push(protection);

      const leak = () =>
        new Response(JSON.stringify({ awsKey: 'AKIAIOSFODNN7EXAMPLE' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      const screened: any = await protection.fetch(leak)(new Request('https://app.example.com/x'));
      const body = await screened.text();

      // The compiled response policy applies, so the secret is still masked.
      expect(body).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(reported.join(' ')).toContain('responseRules');
    });
  }

  it('says nothing, and honours the list, when it is one', async () => {
    // The control. Without it, "blocked" above could mean the allowlist was read and ignored either way.
    const { reached, reported } = await reachesInternalHost({ allowHosts: ['169.254.169.254'] });

    expect(reached, 'a host named in a real list is allowed through').toBe(true);
    expect(reported, 'a well-shaped option is not worth a report').toEqual([]);
  });

  it('reports a wrong shape once, not once per refresh', async () => {
    // The rules are rebuilt on every refresh and the configuration is not what changed, so one mistake
    // must not become a report for as long as the process lives.
    const reported: string[] = [];
    const original = globalThis.fetch;
    stubbed.push(() => {
      globalThis.fetch = original;
    });
    globalThis.fetch = (async (url: string) =>
      String(url).includes('token')
        ? new Response(JSON.stringify({ access_token: 'jwt', expires_in: 3600 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify({ firewall: [], whitelists: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })) as never;

    const protection: any = await createProtection({
      siteUuid: 'a-site',
      pulseRulesUrl: 'https://rules.test/monitor/pulse',
      pulseAuth: 'a-credential-long-enough-to-be-used-here',
      refreshSecret: 'a-refresh-secret',
      responseRules: 'not a list',
      onError: (err: Error) => reported.push(String(err.message)),
    });
    built.push(protection);

    const naming = () => reported.filter((message) => message.includes('responseRules'));
    expect(naming(), 'reported at boot').toHaveLength(1);

    await protection.refresh();
    await protection.refresh();

    expect(naming(), 'and not again for the same configuration').toHaveLength(1);
  });

  it('says nothing when a list option is absent', async () => {
    // `undefined` is the absent value, and the only one.
    const { reached, reported } = await reachesInternalHost({ allowHosts: undefined });

    expect(reached).toBe(false);
    expect(reported).toEqual([]);
  });
});
