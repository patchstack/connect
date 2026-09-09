import { describe, expect, it } from 'vitest';
import { withScreeningLookup, installEgressGuard } from '../../src/protect/egress.js';

/**
 * The resolver the node egress path puts on a request, and what it does with each answer.
 *
 * Exercised by calling it, not by opening a socket: what the connection would then do with the
 * addresses is Node's business, and a real connection makes the assertions depend on what the platform
 * says about a refused port.
 *
 * The rule it exists to keep: an address this screen would refuse must never be the one a connection
 * gets. That fails in two directions — resolving a second time after a failure, and treating something
 * else's resolution as if it were this one — so both are asserted.
 */
type Answer = { err?: unknown; addresses?: unknown; single?: [string, number] };

const TARGET = { url: 'http://api.example.com/x', host: 'api.example.com', method: 'GET' };
const INTERNAL = [{ address: '169.254.169.254', family: 4 }];
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

/** Build the injected resolver, then ask it, collecting what it answers and what it reported. */
function ask(
  options: Record<string, unknown>,
  resolver: (host: string, opts: any, cb: any) => void,
  block: (url: string, host: string, method: string) => boolean = () => false,
  askedFor: Record<string, unknown> = { all: true },
): { answer: Answer; skips: unknown[]; threw?: string } {
  const skips: unknown[] = [];
  const [injected]: any = withScreeningLookup(
    [{ ...options }],
    TARGET,
    block,
    resolver as never,
    (reason: string, detail: unknown) => skips.push({ phase: 'egress', reason, detail }),
  );
  const answers: Answer[] = [];
  let threw: string | undefined;
  try {
    injected.lookup(TARGET.host, askedFor, (err: unknown, a: unknown, b: unknown) => {
      answers.push(err ? { err } : Array.isArray(a) ? { addresses: a } : { single: [a as string, b as number] });
    });
  } catch (err: any) {
    threw = String(err?.message ?? err);
  }

  expect(answers.length, 'answered exactly once').toBeLessThan(2);

  return { answer: answers[0] ?? {}, skips, threw };
}

describe('the resolver the node egress path injects', () => {
  it("resolves through the one the request carried, and hands back what it said", async () => {
    const asked: string[] = [];
    const { answer, skips } = ask(
      {
        lookup: (_host: string, _opts: any, cb: any) => {
          asked.push('app');

          return cb(null, PUBLIC);
        },
      },
      (_host, _opts, cb) => {
        asked.push('guard');

        return cb(null, INTERNAL);
      },
    );

    expect(asked, "the request's own resolver, and only it").toEqual(['app']);
    expect(answer.addresses).toEqual(PUBLIC);
    expect(skips).toEqual([]);
  });

  it('refuses a connection to an address the screen blocks', () => {
    const { answer } = ask({}, (_host, _opts, cb) => cb(null, INTERNAL), (_url, host) => host !== TARGET.host);

    expect(String((answer.err as Error)?.message)).toContain('resolved to 169.254.169.254');
  });

  it('forwards an error the resolver reports, and asks for nothing more', () => {
    let asked = 0;
    const { answer, skips } = ask({}, (_host, _opts, cb) => {
      asked += 1;

      return cb(new Error('resolver broke'));
    });

    expect(String((answer.err as Error)?.message)).toBe('resolver broke');
    expect(asked, 'not asked again, unscreened').toBe(1);
    expect(skips, 'nothing was reached, so nothing was missed').toEqual([]);
  });

  it('forwards a resolver that throws rather than answering, and asks for nothing more', () => {
    let asked = 0;
    const { answer, skips } = ask({}, () => {
      asked += 1;
      throw new Error('cannot list addresses');
    });

    // A resolver that refuses to list addresses is a resolver that failed, whichever way it says so.
    // Asking it again for a single address would connect to whatever it then answered, unscreened.
    expect(String((answer.err as Error)?.message)).toBe('cannot list addresses');
    expect(asked).toBe(1);
    expect(skips).toEqual([]);
  });

  it('leaves a throw from after the answer alone', () => {
    // The resolver answered synchronously and what ran next threw. Translating that into a resolver
    // error would answer the caller a second time, for a call that already had its answer.
    const { threw } = ask({}, (_host, _opts, cb) => {
      cb(null, PUBLIC);
      throw new Error('something after the answer');
    });

    expect(threw, "not turned into this resolver's failure").toBe('something after the answer');
  });

  it('hands back the addresses already resolved, and reports it, when the screen itself fails', () => {
    let asked = 0;
    const { answer, skips } = ask(
      {},
      (_host, _opts, cb) => {
        asked += 1;

        return cb(null, PUBLIC);
      },
      () => {
        throw new Error('the screen broke');
      },
    );

    // Ours is the only failure this falls open for, and it falls open onto what is already in hand: a
    // second resolution is how an address the screen would have refused becomes the one that connects.
    expect(asked, 'resolved once, not again').toBe(1);
    expect(answer.addresses).toEqual(PUBLIC);
    expect(skips).toEqual([{ phase: 'egress', reason: 'screen-failed', detail: { host: TARGET.host } }]);
  });

  it('answers in the shape the caller asked for', () => {
    const { answer } = ask({}, (_host, _opts, cb) => cb(null, PUBLIC), () => false, { all: false });

    expect(answer.single).toEqual(['93.184.216.34', 4]);
  });
});
