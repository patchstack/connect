/**
 * The request header that asks the guard to fetch its rules now, during that request. Patchstack sends it
 * to the live app after the site's rules change, so the change applies without waiting for the interval.
 * It only moves the time of the guard's ordinary authenticated fetch, at most once per `forceGapMs`.
 */
export const SYNC_HEADER = 'x-patchstack-sync';

/** Request-triggered refresh complements timers on hosts which freeze between requests. */
export function requestRefresh(tick, {intervalMs, timeoutMs, forceGapMs = 15_000, now = Date.now} = {}) {
  let due = now() + intervalMs;
  let lastForced = -Infinity;
  let inflight = null;
  let failures = 0;
  let stopped = false;
  function note(ok) {
    failures = ok ? 0 : Math.min(failures + 1, 3);
    due = now() + intervalMs * (2 ** failures);
  }
  // `force` (a sync request) skips the interval and any backoff, but not the gap between forced fetches,
  // so the header cannot be used to make the guard ask more often than that.
  function check(force = false) {
    if (stopped || !(intervalMs > 0)) return null;
    if (inflight) return inflight;
    const forced = force && now() - lastForced >= forceGapMs;
    if (!forced && now() < due) return null;
    if (forced) lastForced = now();
    let timer;
    const work = Promise.resolve().then(tick).then(result => { note(result?.ok !== false); }, () => { note(false); });
    // A broken transport or custom store must not hold an application request indefinitely.
    const bounded = new Promise(resolve => { timer = setTimeout(() => { note(false); resolve(); }, timeoutMs); });
    inflight = Promise.race([work, bounded]).finally(() => { clearTimeout(timer); inflight = null; });
    return inflight;
  }
  return {check, note, stop:()=>{stopped=true;}};
}
