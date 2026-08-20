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
 * @returns {boolean} whether the callback ran to completion — lets a caller fall back to its own
 *   reporting when a host's handler is broken, rather than losing the report entirely
 */

/** Hooks already reported as broken. Module-scoped: one warning per hook per process, not per guard. */
const reported = new Set();

export function notify(fn, arg, label) {
  if (typeof fn !== 'function') return false;

  try {
    fn(arg);

    return true;
  } catch (err) {
    if (!reported.has(label)) {
      reported.add(label);
      try {
        // Named as the host's callback, not as a Patchstack failure: pointing at ourselves for someone
        // else's throw sends them reading the wrong code.
        console.warn(
          `Patchstack: the ${label} callback passed to createProtection threw and was ignored. ` +
            `Protection is unaffected; this is reported once per process. ` +
            `Cause: ${err && err.message ? err.message : String(err)}`,
        );
      } catch {
        /* no console on this runtime */
      }
    }

    return false;
  }
}

/** Test seam: forget which hooks have been reported, so warn-once is assertable more than once. */
export function resetNotifyWarnings() {
  reported.clear();
}
