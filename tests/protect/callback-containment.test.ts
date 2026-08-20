import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';
import { notify, resetNotifyWarnings } from '../../src/protect/notify.js';
import { createFetchMiddleware } from '../../src/protect/engine/fetch.js';

/**
 * A callback the host passed in must never break the guard that calls it.
 *
 * `onError`, `onDetect` and `onSkip` run host code, and this package's whole promise is that it does not
 * take down the app it protects. `onSkip` was already wrapped for exactly that reason; the other two were
 * not, and the sharper case is `onDetect`, which fires only when a rule matched — so an unguarded throw
 * converted "we noticed something" into "the request died", on precisely the requests that mattered.
 *
 * Every containment test here is paired with a control, because "contained" has a cheap wrong
 * implementation: never call the callback at all.
 */
const RULES = {
  firewall: [
    { id: 'r1', title: 'marker in the query', rule_v2: [{ parameter: 'get.q', match: { type: 'contains', value: 'boom' } }] },
  ],
};

const app = async () => new Response('ok', { status: 200 });
const hit = () => new Request('https://x.test/?q=boom');
const miss = () => new Request('https://x.test/?q=fine');
const boom = () => {
  throw new Error('host callback is broken');
};
/** The shape a try/catch cannot contain: it returns a rejected promise instead of throwing. */
const asyncBoom = async () => {
  throw new Error('host callback rejected');
};

/** Unhandled rejections during `fn`, which on Node terminate the process by default. */
async function unhandledDuring(fn: () => Promise<unknown>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (err: unknown) => seen.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    // Rejections surface a macrotask later than the code that caused them.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  return seen;
}

describe('a throwing host callback cannot break the guard', () => {
  beforeEach(() => {
    resetNotifyWarnings();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.PATCHSTACK_MODE;
    vi.restoreAllMocks();
  });

  it('serves the request when onDetect throws', async () => {
    const p = await createProtection({ rules: RULES, onDetect: boom });

    // Was: the throw propagated out of the guard and the request failed. In dry-run the request is
    // allowed, so allowing it is the correct outcome — the detection is lost, the request is not.
    expect((await p.fetch(app)(hit())).status).toBe(200);
    // And it is not a one-shot failure that leaves the guard wedged for everything after it.
    expect((await p.fetch(app)(hit())).status).toBe(200);
    expect((await p.fetch(app)(miss())).status).toBe(200);
  });

  it('still BLOCKS when onDetect throws, rather than failing open past the rule', async () => {
    // The containment must not become a bypass. A reporting callback is downstream of the decision, so a
    // broken one costs the report — never the enforcement. Without this, "contained" could have meant
    // swallowing the whole detection path and letting the request through.
    process.env.PATCHSTACK_MODE = 'block';
    const p = await createProtection({ rules: RULES, onDetect: boom });

    expect((await p.fetch(app)(hit())).status).toBe(403);
    expect((await p.fetch(app)(miss())).status).toBe(200);
  });

  it('still calls a callback that works', async () => {
    // The control for both tests above.
    const seen: unknown[] = [];
    const p = await createProtection({ rules: RULES, onDetect: (d: unknown) => seen.push(d) });

    await p.fetch(app)(hit());

    expect(seen).toHaveLength(1);
  });

  it('boots when onError throws', async () => {
    // The rule fetch fails here (no network), which is a reported, recoverable condition — the guard falls
    // back to the inline rules. Reporting that condition to a broken handler used to abort the boot, so an
    // app lost its protection entirely over a bug in its own logging callback.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));

    const p = await createProtection({ siteUuid: 'site-1', rules: RULES, onError: boom, cwd: '/nonexistent' });

    expect(p.mode).toBeDefined();
    expect((await p.fetch(app)(hit())).status).toBe(200);
  });

  it('refreshes when onError throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    const p = await createProtection({ siteUuid: 'site-1', rules: RULES, onError: boom, cwd: '/nonexistent' });

    // A refresh reports the same failure. It must settle rather than reject: an unhandled rejection in a
    // poll loop is how a long-lived process dies hours after the mistake was made.
    await expect(p.refresh()).resolves.not.toThrow();

    p.stopRefresh?.();
  });

  it('keeps serving when onSkip throws', async () => {
    // Pre-existing behaviour, locked down: this one was already wrapped, and the fix must not have
    // disturbed it while generalising the rule it demonstrated.
    const p = await createProtection({ rules: RULES, onSkip: boom, maxBodyBytes: 8 });
    const big = new Request('https://x.test/', { method: 'POST', body: 'x'.repeat(64) });

    expect((await p.fetch(app)(big)).status).toBe(200);
  });
});

describe('notify', () => {
  beforeEach(() => {
    resetNotifyWarnings();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports whether the callback ran, so a caller can fall back', () => {
    // The engine relies on this: a host handler that RUNS takes over reporting, one that THROWS must not,
    // or a rule error would vanish between two broken reporters.
    expect(notify(() => undefined, 'x', 'onError')).toBe(true);
    expect(notify(boom, 'x', 'onError')).toBe(false);
    expect(notify(undefined, 'x', 'onError')).toBe(false);
    expect(notify('not a function', 'x', 'onError')).toBe(false);
  });

  it('warns once per callback, not once per call', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 5; i++) notify(boom, 'x', 'onDetect');

    // These run per request. A warning per failure would turn one bug into an unbounded log flood, and
    // silence would hide it forever — so exactly one, naming the callback.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('onDetect');
  });

  it('survives a runtime with no console', () => {
    // The warning is a diagnostic; it does not get to be the thing that breaks containment.
    const original = globalThis.console;
    try {
      // @ts-expect-error deliberately removing console for this case
      globalThis.console = undefined;
      expect(() => notify(boom, 'x', 'onError')).not.toThrow();
    } finally {
      globalThis.console = original;
    }
  });
});


describe('an async callback is contained too', () => {
  beforeEach(() => {
    resetNotifyWarnings();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.PATCHSTACK_MODE;
    vi.restoreAllMocks();
  });

  it('produces no unhandled rejection when onDetect is async and rejects', async () => {
    // `async () => { throw }` does not throw — it returns a rejected promise, so a try/catch around the
    // call sees nothing and the rejection lands after containment has already returned. On Node an
    // unhandled rejection terminates the process by default, which trades the throw we contained for
    // something worse: the app dying, on the requests where a rule matched.
    const p = await createProtection({ rules: RULES, onDetect: asyncBoom });

    const unhandled = await unhandledDuring(async () => {
      expect((await p.fetch(app)(hit())).status).toBe(200);
    });

    expect(unhandled).toEqual([]);
  });

  it('still enforces when an async onDetect rejects', async () => {
    process.env.PATCHSTACK_MODE = 'block';
    const p = await createProtection({ rules: RULES, onDetect: asyncBoom });

    const unhandled = await unhandledDuring(async () => {
      expect((await p.fetch(app)(hit())).status).toBe(403);
    });

    expect(unhandled).toEqual([]);
  });

  it('boots with no unhandled rejection when onError is async and rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));

    const unhandled = await unhandledDuring(async () => {
      const p = await createProtection({ siteUuid: 'site-1', rules: RULES, onError: asyncBoom, cwd: '/nonexistent' });
      expect(p.mode).toBeDefined();
    });

    expect(unhandled).toEqual([]);
  });

  it('awaits nothing and reports the failure once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const unhandled = await unhandledDuring(async () => {
      for (let i = 0; i < 4; i++) notify(asyncBoom, 'x', 'onDetect');
    });

    expect(unhandled).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves a resolving async callback alone', async () => {
    // The control: containment must not have become "never call it", and a callback that works must not
    // be reported as broken.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: unknown[] = [];

    const unhandled = await unhandledDuring(async () => {
      const p = await createProtection({
        rules: RULES,
        onDetect: async (d: unknown) => {
          seen.push(d);
        },
      });
      await p.fetch(app)(hit());
    });

    expect(seen).toHaveLength(1);
    expect(unhandled).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('a throwing onBlock cannot decide the enforcement outcome', () => {
  beforeEach(() => {
    resetNotifyWarnings();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still returns the block response on the fetch adapter', async () => {
    // This callback runs after the decision to block and before the 403 is built. An escaping throw did
    // not let the request through — it replaced the block with the callback's exception, so untrusted
    // reporting code chose what a blocked request returned. Availability aside, that is enforcement
    // integrity: the outcome of a block must come from the rule, never from the reporting hook.
    const guard = createFetchMiddleware(RULES, { onBlock: boom });

    const res = await guard(hit());

    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });

  it('still returns the block response when onBlock rejects asynchronously', async () => {
    const guard = createFetchMiddleware(RULES, { onBlock: asyncBoom });

    const unhandled = await unhandledDuring(async () => {
      expect((await guard(hit()))?.status).toBe(403);
    });

    expect(unhandled).toEqual([]);
  });

  it('still calls an onBlock that works, with the rule that fired', async () => {
    const seen: Array<{ rule?: { id?: string } }> = [];
    const guard = createFetchMiddleware(RULES, { onBlock: (info: { rule?: { id?: string } }) => seen.push(info) });

    await guard(hit());

    expect(seen).toHaveLength(1);
    expect(seen[0]?.rule?.id).toBe('r1');
  });
});
