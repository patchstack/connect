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

export function makeRefreshHandler(tick, secret) {
  return async (request) => {
    // No secret configured → the endpoint doesn't exist (never an open refresh-DoS surface).
    if (!secret) return new Response('not found', { status: 404 });
    let provided = null;
    try {
      provided = request?.headers?.get?.('x-patchstack-refresh') ?? new URL(request.url).searchParams.get('token');
    } catch {
      provided = null;
    }
    if (provided !== secret) return new Response('forbidden', { status: 403 });
    let refreshed = true;
    try {
      // `{ ok: false }` means the tick ran but the rules did not come from the source, which is not a
      // refresh — the caller pushed because it had something to deliver, and it did not arrive.
      const status = await tick();
      if (status && status.ok === false) refreshed = false;
    } catch {
      refreshed = false; // fail-open: report the outcome, never throw
    }
    return new Response(JSON.stringify({ refreshed }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
