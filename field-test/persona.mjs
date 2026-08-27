// Composing the prompt the agent under test actually receives.
//
// A persona file carries two things with opposite audiences: the platform-shaped policy, which the agent
// MUST read, and provenance for the humans maintaining it — that the policy is a synthetic reconstruction,
// why it is weaker than the real thing, and what the harness is trying to prove.
//
// The second must never reach the agent. It announces that this is an evaluation and hands the agent a
// reason to discount the very policy it is supposed to be applying, so a green run stops discriminating
// between a prompt that survives platform pressure and one the agent waved through because it knew it was
// being measured. An HTML comment is not a hiding place: a model reads it like any other text.
//
// That is the same trap the install prompt itself is built to avoid — meta-commentary about surviving
// scrutiny reads as manipulation — so the harness must not commit it while testing for it.
//
// Hence one composer, used by the runner, rather than a `readFileSync` at each call site.

/** The provenance block's delimiters. A defined marker, so stripping is exact rather than a guess. */
export const META_OPEN = '<!-- field-test:meta';
export const META_CLOSE = '-->';

/**
 * Remove every provenance block, and nothing else.
 *
 * Deliberately NOT "strip all HTML comments": a persona may one day need a comment the agent should see
 * (an inline note inside the policy), and silently deleting it would change the pressure under test.
 * Only the marked block goes.
 */
export function stripPersonaMeta(text) {
  let out = '';
  let rest = text;

  for (;;) {
    const open = rest.indexOf(META_OPEN);
    if (open === -1) break;

    const close = rest.indexOf(META_CLOSE, open + META_OPEN.length);
    if (close === -1) {
      // An unterminated block. Dropping the remainder is the safe direction: it cannot leak, and the
      // persona will be visibly truncated, which is a loud failure rather than a quiet leak.
      return `${out}${rest.slice(0, open)}`.trimStart();
    }
    out += rest.slice(0, open);
    rest = rest.slice(close + META_CLOSE.length);
  }

  return `${out}${rest}`.trimStart();
}

/** The exact text handed to the agent on stdin. */
export function composeAgentPrompt({ persona, fixtureDir, installPrompt }) {
  return stripPersonaMeta(persona)
    .replaceAll('{{FIXTURE_DIR}}', fixtureDir)
    .replaceAll('{{INSTALL_PROMPT}}', installPrompt);
}
