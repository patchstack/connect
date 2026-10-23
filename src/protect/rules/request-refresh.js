/**
 * The request header that asks the guard to fetch its rules now, during that request. Patchstack sends it
 * to the live app after the site's rules change, so the change applies without waiting for the interval.
 * It only moves the time of the guard's ordinary authenticated fetch, at most once per `forceGapMs`.
 */
export const SYNC_HEADER = 'x-patchstack-sync';

/**
 * Request-triggered refresh complements timers on hosts which freeze between requests.
 *
 * Two deadlines. Past `intervalMs` the rules are stale: the request waits for the fetch, because on a host
 * that freezes between requests nothing else will run it. Past `backgroundMs` (shorter) the rules are only
 * worth re-checking: the fetch starts but no request waits for it, and the caller hands it to the host to
 * finish (`waitUntil`) where it can. A background check the host cuts off is caught by the stale deadline.
 *
 * `check()` returns null when nothing is due, or `{promise, wait}`: `wait` says whether this request
 * should hold for `promise`.
 */
export function requestRefresh(tick, {intervalMs, backgroundMs = 0, timeoutMs, forceGapMs = 15_000, now = Date.now} = {}) {
  let due = now() + intervalMs;
  let backgroundDue = now() + backgroundMs;
  let lastForced = -Infinity;
  let inflight = null;
  let failures = 0;
  let stopped = false;
  function note(ok) {
    failures = ok ? 0 : Math.min(failures + 1, 3);
    due = now() + intervalMs * (2 ** failures);
    backgroundDue = now() + backgroundMs * (2 ** failures);
  }
  function start() {
    let timer;
    const work = Promise.resolve().then(tick).then(result => { note(result?.ok !== false); }, () => { note(false); });
    // A broken transport or custom store must not hold an application request indefinitely.
    const bounded = new Promise(resolve => { timer = setTimeout(() => { note(false); resolve(); }, timeoutMs); });
    inflight = Promise.race([work, bounded]).finally(() => { clearTimeout(timer); inflight = null; });
    return inflight;
  }
  // `force` (a sync request) skips the interval and any backoff, but not the gap between forced fetches,
  // so the header cannot be used to make the guard ask more often than that.
  function check(force = false) {
    if (stopped || !(intervalMs > 0)) return null;
    const forced = force && now() - lastForced >= forceGapMs;
    const stale = forced || now() >= due;
    if (inflight) return {promise: inflight, wait: stale};
    if (stale) {
      if (forced) lastForced = now();
      return {promise: start(), wait: true};
    }
    if (backgroundMs > 0 && backgroundMs < intervalMs && now() >= backgroundDue) {
      return {promise: start(), wait: false};
    }
    return null;
  }
  return {check, note, stop:()=>{stopped=true;}};
}
