import { describe, expect, it, afterEach, vi } from 'vitest';
import { sentinelAnswer, VERIFY_HEADER } from '../../src/protect/verify-sentinel.js';
// The value the harness will compare against, computed its way (node crypto) rather than the seam's
// (web crypto). Asserting the seam against the OTHER implementation is what makes the two agree.
import { expectedAnswerFor } from '../../src/protect/install/runtime/probe.js';

/**
 * When a scaffolded guard answers a verification request, and when it does nothing at all.
 *
 * This code sits on the request path of every app that installs a guard, so every state other than a
 * live verification leaves the request untouched. A live verification exists only in a process the
 * harness started, holding a challenge it minted for that run.
 */
const CHALLENGE = 'c'.repeat(64);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the answer to a verification request', () => {
  it('is a digest of the challenge, not the challenge itself', async () => {
    vi.stubEnv('PATCHSTACK_VERIFY_CHALLENGE', CHALLENGE);

    const answer = await sentinelAnswer(CHALLENGE);

    // Derived rather than echoed, so the harness can tell this seam's answer from an app that reflects
    // request headers — and from a route that happens to return a fixed string.
    expect(answer).toBe(expectedAnswerFor(CHALLENGE));
    expect(answer).not.toBe(CHALLENGE);
    expect(answer).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for a different challenge', async () => {
    const other = 'd'.repeat(64);

    expect(expectedAnswerFor(CHALLENGE)).not.toBe(expectedAnswerFor(other));
  });

  for (const [what, offered] of [
    ['nothing is offered', undefined],
    ['the wrong value is offered', 'd'.repeat(64)],
    ['a prefix of the challenge is offered', CHALLENGE.slice(0, 32)],
    ['the offered value is not a string', 12345],
  ] as const) {
    it(`is nothing when ${what}`, async () => {
      vi.stubEnv('PATCHSTACK_VERIFY_CHALLENGE', CHALLENGE);

      expect(await sentinelAnswer(offered as never)).toBeNull();
    });
  }

  it('is nothing when no challenge was configured, whatever is offered', async () => {
    vi.stubEnv('PATCHSTACK_VERIFY_CHALLENGE', '');

    // The production state: the branch exists and cannot be entered, whoever asks.
    expect(await sentinelAnswer(CHALLENGE)).toBeNull();
    expect(await sentinelAnswer('')).toBeNull();
  });

  it('is nothing when the configured challenge is too short to be one of ours', async () => {
    // A guess at the variable rather than a challenge the harness minted.
    vi.stubEnv('PATCHSTACK_VERIFY_CHALLENGE', 'short');

    expect(await sentinelAnswer('short')).toBeNull();
  });

  it('fails open, rather than throwing, on a runtime with no web crypto', async () => {
    vi.stubEnv('PATCHSTACK_VERIFY_CHALLENGE', CHALLENGE);
    // Restored from its own descriptor: on Node this is an accessor, and replacing it with a data
    // property would leave every later test with a different shape than it had.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    // @ts-expect-error - removing it is the point
    delete globalThis.crypto;
    try {
      // What is established is the fail-open: no throw on the request path, and no interception of
      // ordinary traffic. Runtime verification needs web crypto and only ever runs where it is present,
      // so this state has no verification outcome of its own — a run against it would read as a seam
      // the request did not reach.
      expect(await sentinelAnswer(CHALLENGE)).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    }
  });

  it('names the header the harness sends', () => {
    expect(VERIFY_HEADER).toBe('x-patchstack-verify');
  });
});
