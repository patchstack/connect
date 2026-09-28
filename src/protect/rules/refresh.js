// Rule refresh scheduling — how a long-lived guard picks up rules that become relevant after boot
// (a dependency added mid-session, a zero-day published). Two triggers, both driving the same
// caller-supplied `tick` (which re-fetches + hot-swaps the engines):
//   - startRefresh: a self-scheduling poll LOOP (reschedules after each tick settles, so runs never
//     overlap), with ±jitter (avoid a thundering herd) and exponential backoff on consecutive
//     failures. `unref`'d — it never keeps the process alive. A tick counts as failed when it throws
//     OR when it reports `{ ok: false }`: the rule resolver absorbs an API or network failure into
//     usable fallback rules, so a thrown error is not the only shape an outage takes, and a poller
//     that waits for one keeps the whole fleet knocking at the normal interval while it lasts.
//   - makeRefreshHandler: a PUSH endpoint — an authenticated fetch handler the platform/SaaS hits
//     for an immediate refresh (zero-day fast lane) instead of waiting for the next poll.

import { notify } from '../notify.js';

const JITTER_FRACTION = 0.1;
const MAX_BACKOFF_MULTIPLIER = 8; // cap consecutive-failure backoff at 8× the base interval

export function startRefresh(tick, { refreshMs, onError } = {}) {
  let stopped = false;
  let failures = 0;
  let timer = null;

  const schedule = () => {
    if (stopped) return;
    const backoff = Math.min(2 ** failures, MAX_BACKOFF_MULTIPLIER);
    const jitter = 1 - Math.random() * JITTER_FRACTION; // shorten by up to 10% so clients don't align
    const delay = refreshMs * backoff * jitter;
    timer = setTimeout(run, delay);
    timer?.unref?.();
  };

  const run = async () => {
    if (stopped) return;
    try {
      const status = await tick();
      if (status && status.ok === false) failures++;
      else failures = 0;
    } catch (err) {
      failures++;
      notify(onError, err, 'onError');
    }
    schedule();
  };

  schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Retry a rules source that failed, until one attempt comes back clean — for a guard with no poll loop.
 *
 * Without a loop a guard resolves its rules once, at boot, and a single slow or failed call there leaves
 * a long-lived server on its cache or its bundled fallback until it restarts. This asks again on a
 * lengthening schedule, and stops for good at the first attempt that reports `ok`. `unref`'d, like the
 * loop, so it never keeps the process alive.
 */
const RECOVERY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000, 600_000];

export function startRecovery(tick, { onError } = {}) {
  let stopped = false;
  let attempt = 0;
  let timer = null;

  const schedule = () => {
    if (stopped) return;
    const delay = RECOVERY_DELAYS_MS[Math.min(attempt, RECOVERY_DELAYS_MS.length - 1)];
    timer = setTimeout(run, delay * (1 - Math.random() * JITTER_FRACTION));
    timer?.unref?.();
  };

  const run = async () => {
    if (stopped) return;
    attempt++;
    try {
      const status = await tick();
      if (!status || status.ok !== false) {
        stopped = true;

        return;
      }
    } catch (err) {
      notify(onError, err, 'onError');
    }
    schedule();
  };

  schedule();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * One refresh at a time, whichever trigger asked.
 *
 * The poll loop, recovery, a manual `refresh()` and a push each run the same tick, and two of them
 * running at once let the one that FINISHES last decide the rules — which is not the one that started
 * last. A slow tick holding an older response would then undo a push that had just delivered a new
 * rule, and write that older response's ETag over the newer one.
 *
 * So a tick never overlaps another. A call made while one is running gets one that starts after it —
 * shared by every call made in the meantime, so a burst of triggers costs one extra tick, not one each.
 */
export function serialise(tick) {
  let running = null;
  let next = null;

  const run = () => {
    if (!running) {
      running = Promise.resolve()
        .then(() => tick())
        .finally(() => {
          running = null;
        });

      return running;
    }
    if (!next) {
      next = running
        .catch(() => {})
        .then(() => {
          next = null;

          return run();
        });
    }

    return next;
  };

  return run;
}

export function makeRefreshHandler(tick, secret) {
  let inflight = null;

  const runOnce = () => {
    if (inflight) return inflight;
    let current;
    current = Promise.resolve()
      .then(() => tick())
      .finally(() => {
        if (inflight === current) inflight = null;
      });
    inflight = current;
    return current;
  };

  return async (request) => {
    // No secret configured → the endpoint doesn't exist (never an open refresh-DoS surface).
    if (!secret) return new Response('not found', { status: 404 });
    const provided = request?.headers?.get?.('x-patchstack-refresh') ?? null;
    if (!(await sameSecret(provided, secret))) return new Response('forbidden', { status: 403 });
    let refreshed = true;
    try {
      // `{ ok: false }` means the tick ran but the rules did not come from the source, which is not a
      // refresh — the caller pushed because it had something to deliver, and it did not arrive.
      const status = await runOnce();
      if (status && status.ok === false) refreshed = false;
    } catch {
      refreshed = false; // fail-open: report the outcome, never throw
    }
    return new Response(JSON.stringify({ refreshed }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/**
 * Whether a presented refresh secret equals the configured one, in time that does not depend on where
 * they first differ.
 *
 * Both are digested and the fixed-length digests compared in full, so neither the position of the first
 * differing character nor the secret's length shapes the time taken. Without Web Crypto the strings are
 * compared in full over the longer length instead.
 */
async function sameSecret(provided, secret) {
  if (typeof provided !== 'string' || typeof secret !== 'string') return false;
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof TextEncoder === 'function') {
    try {
      const encoder = new TextEncoder();
      const [a, b] = await Promise.all([
        subtle.digest('SHA-256', encoder.encode(provided)),
        subtle.digest('SHA-256', encoder.encode(secret)),
      ]);

      return equalBytes(new Uint8Array(a), new Uint8Array(b));
    } catch {
      // Fall through to the full-length comparison.
    }
  }
  let diff = provided.length ^ secret.length;
  const length = Math.max(provided.length, secret.length);
  for (let i = 0; i < length; i++) {
    diff |= (provided.charCodeAt(i) || 0) ^ (secret.charCodeAt(i) || 0);
  }

  return diff === 0;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];

  return diff === 0;
}
