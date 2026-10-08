/** Request-triggered refresh complements timers on hosts which freeze between requests. */
export function requestRefresh(tick, {intervalMs, timeoutMs, now = Date.now} = {}) {
  let due = now() + intervalMs;
  let inflight = null;
  let failures = 0;
  let stopped = false;
  function note(ok) {
    failures = ok ? 0 : Math.min(failures + 1, 3);
    due = now() + intervalMs * (2 ** failures);
  }
  function check() {
    if (stopped || !(intervalMs > 0)) return null;
    if (inflight) return inflight;
    if (now() < due) return null;
    let timer;
    const work = Promise.resolve().then(tick).then(result => { note(result?.ok !== false); }, () => { note(false); });
    // A broken transport or custom store must not hold an application request indefinitely.
    const bounded = new Promise(resolve => { timer = setTimeout(() => { note(false); resolve(); }, timeoutMs); });
    inflight = Promise.race([work, bounded]).finally(() => { clearTimeout(timer); inflight = null; });
    return inflight;
  }
  return {check, note, stop:()=>{stopped=true;}};
}
