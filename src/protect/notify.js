/**
 * Deliver a value to a caller-supplied callback without letting it break anything.
 *
 * `onError`, `onDetect` and `onSkip` are hooks a host passes in, so their code is not ours and its
 * failure is not ours to inherit. This package's one promise is that it never takes down the app it
 * protects — an engine error fails open, a malformed rule is skipped, a slow API boots from cache. A
 * reporting hook that throws has to fail open for the same reason, and for a sharper one: it fires
 * exactly when something interesting happened, so an unguarded throw converts "we noticed something"
 * into "the request died", and does it only on the requests that mattered.
 *
 * `onSkip` was already wrapped this way, with the reason written next to it. This is that same rule,
 * applied to the hooks that were missed rather than restated for one of them.
 *
 * Not silent, though. A hook that throws is a bug in the host's code and swallowing it entirely would
 * hide it forever, so the first failure per hook is reported — once, because these run per request and a
 * persistently broken hook would otherwise print on every one. Same reasoning as the engine's
 * report-once for a persistently broken rule.
 *
 * @param {unknown} fn the callback, or anything that is not a function (then this is a no-op)
 * @param {unknown} arg the single argument to hand it
 * @param {string} label which hook, for the one-time warning
 * @returns {boolean} whether the callback ran to completion, so a caller can fall back to its own
 *   reporting rather than losing the report entirely. For an ASYNC callback this can only mean it
 *   started: a rejection arrives after we return, and is contained and warned about, but by then a
 *   caller has already decided not to fall back. Synchronous handlers get the stronger answer.
 */

/** Hooks already reported as broken. Module-scoped: one warning per hook per process, not per guard. */
const reported = new Set();

export function notify(fn, arg, label) {
  if (typeof fn !== 'function') return false;

  try {
    const result = fn(arg);

    // An ASYNC callback fails after this function has already returned. `async () => { throw ... }` does
    // not throw — it hands back a rejected promise, and an unhandled rejection terminates the process by
    // default on Node. So a try/catch alone would contain the synchronous hosts and leave the async ones
    // able to kill the app, which is a worse outcome than the throw we set out to contain.
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      try {
        result.then(undefined, (err) => warnOnce(label, err));
      } catch {
        // A `then` that throws on access. Nothing more to attach to; the value is not a usable promise.
      }
    }

    return true;
  } catch (err) {
    warnOnce(label, err);

    return false;
  }
}

/**
 * Report a broken callback once per process.
 *
 * Must not throw: it runs inside the containment, so its own failure would be the thing that breaks the
 * guarantee it exists to report on.
 */
function warnOnce(label, err) {
  if (reported.has(label)) return;
  reported.add(label);
  try {
    // Named as the host's callback, not as a Patchstack failure: pointing at ourselves for someone
    // else's throw sends them reading the wrong code.
    console.warn(
      `Patchstack: the ${label} callback passed to createProtection failed and was ignored. ` +
        `Protection is unaffected; this is reported once per process. ` +
        `Cause: ${err && err.message ? err.message : String(err)}`,
    );
  } catch {
    /* no console on this runtime */
  }
}

/** Test seam: forget which hooks have been reported, so warn-once is assertable more than once. */
export function resetNotifyWarnings() {
  reported.clear();
}
