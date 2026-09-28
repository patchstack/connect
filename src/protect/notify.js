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
 * hide it forever, so the first failure of each callback is reported — once, because these run per request
 * and a persistently broken hook would otherwise print on every one. Same reasoning as the engine's
 * report-once for a persistently broken rule. "Each callback" is each function under each hook name, so a
 * second guard's broken hook is reported even after the first guard's was; the total is capped, so a host
 * that creates a fresh callback per request cannot turn this into per-request output.
 *
 * @param {unknown} fn the callback, or anything that is not a function (then this is a no-op)
 * @param {unknown} arg the single argument to hand it
 * @param {string} label which hook, for the one-time warning
 * @returns {boolean} whether the callback ran to completion, so a caller can fall back to its own
 *   reporting rather than losing the report entirely. For an ASYNC callback this can only mean it
 *   started: a rejection arrives after we return, and is contained and warned about, but by then a
 *   caller has already decided not to fall back. Synchronous handlers get the stronger answer.
 */

/** Callbacks already reported as broken, by function, then by hook name. */
let reported = new WeakMap();

/** Warnings written so far, and the most this process writes before saying the rest are suppressed. */
let warnings = 0;
const MAX_WARNINGS = 20;

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
        result.then(undefined, (err) => warnOnce(fn, label, err));
      } catch {
        // A `then` that throws on access. Nothing more to attach to; the value is not a usable promise.
      }
    }

    return true;
  } catch (err) {
    warnOnce(fn, label, err);

    return false;
  }
}

/**
 * Report a broken callback once.
 *
 * Must not throw: it runs inside the containment, so its own failure would be the thing that breaks the
 * guarantee it exists to report on.
 */
function warnOnce(fn, label, err) {
  let labels = reported.get(fn);
  if (labels?.has(label)) return;
  if (!labels) {
    labels = new Set();
    reported.set(fn, labels);
  }
  labels.add(label);
  if (warnings > MAX_WARNINGS) return;
  warnings++;
  try {
    if (warnings > MAX_WARNINGS) {
      console.warn('Patchstack: further failing callbacks passed to createProtection are not reported in this process.');

      return;
    }
    // Named as the host's callback, not as a Patchstack failure: pointing at ourselves for someone
    // else's throw sends them reading the wrong code.
    console.warn(
      `Patchstack: the ${label} callback passed to createProtection failed and was ignored. ` +
        `Protection is unaffected; this callback's failures are reported once. ` +
        `Cause: ${err && err.message ? err.message : String(err)}`,
    );
  } catch {
    /* no console on this runtime */
  }
}

/** Test seam: forget which hooks have been reported, so warn-once is assertable more than once. */
export function resetNotifyWarnings() {
  reported = new WeakMap();
  warnings = 0;
}
