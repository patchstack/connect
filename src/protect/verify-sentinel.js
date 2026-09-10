// The seam side of `protect --check --runtime`. Every other wiring check reads the app's source and
// answers "is the edit present"; this one answers "did a request arrive at the seam".
//
// It is inert unless a verification is running. There is no sentinel without a challenge in the
// environment, and the harness mints a fresh random one per run and passes it only to the child it
// starts. No challenge, or a request offering the wrong value, and this returns null — the seam then
// does what it always does with that request.
//
// The answer is a digest of the challenge rather than an echo of it or a fixed string, which rules out
// the two ways an app could match by accident: a route that happens to return a fixed body, and an app
// that reflects request headers. It is not proof of which module answered. The challenge is an
// environment variable the whole child process can read and `sentinelAnswer` is exported, so any code
// in that process could compute the same value; what the digest establishes is that something holding
// the challenge answered, not that this file did.
export const VERIFY_HEADER = 'x-patchstack-verify';

/** The environment variable that carries the challenge for a runtime verification. */
const CHALLENGE = 'PATCHSTACK_VERIFY_CHALLENGE';

/** Read the challenge without assuming a `process` (this file is in the edge-safe graph). */
function configuredChallenge() {
  const value = typeof process !== 'undefined' ? process.env?.[CHALLENGE] : undefined;

  return typeof value === 'string' && value.length >= 32 ? value : null;
}

/**
 * Compare two values without revealing where they first differ.
 *
 * A type or length mismatch is rejected before the loop; equal-length values are scanned in full. This
 * is defence in depth rather than a requirement: the challenge is not a credential, it authorises
 * nothing, and it expires with the process.
 */
function sameValue(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let differs = 0;
  for (let i = 0; i < a.length; i += 1) differs |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return differs === 0;
}

/**
 * The answer to a verification request, or null when there is nothing to answer.
 *
 * Null is the answer for every case that is not a live verification: no challenge configured, nothing
 * offered, or the wrong value offered.
 *
 * Web crypto is relied on rather than worked around. A verification only happens in a process the
 * harness started, the harness only starts what Node can load directly, and every runtime at this
 * package's supported floor (Node 20) has `crypto.subtle`. The guard on an edge runtime never takes
 * this branch, because nothing there sets a challenge. A build with no web crypto at all would read to
 * the harness as a seam the request did not reach — stated here rather than dressed as a third outcome
 * the caller cannot act on.
 *
 * @param {unknown} offered the value the seam read from the verify header
 * @returns {Promise<string|null>} the body to answer with, or null to carry on as normal
 */
export async function sentinelAnswer(offered) {
  const challenge = configuredChallenge();
  if (challenge === null || !sameValue(challenge, typeof offered === 'string' ? offered : null)) return null;

  // Guarded, not because a supported runtime can be missing this, but because a seam on the request
  // path may not throw for anything — including a runtime that surprises us.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function' || typeof TextEncoder === 'undefined') return null;

  try {
    const bytes = new TextEncoder().encode(`patchstack-verify:${challenge}`);
    const digest = await subtle.digest('SHA-256', bytes);

    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // A runtime that has `subtle.digest` and refuses to use it. Nothing to answer with, so nothing is
    // claimed: the request goes on to the app exactly as it would have.
    return null;
  }
}
