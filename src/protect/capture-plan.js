/**
 * What a rule permits to be captured as evidence — derived from the rule, never from the traffic.
 *
 * A detection says a rule matched. On its own that is enough to count hits, and not enough to act on:
 * whoever triages it still has to decide whether the request was really an attack, and for that they need
 * to see what the rule saw. Capturing that is the difference between a counter and evidence.
 *
 * It is also the point where a security channel could quietly become a copy of an application's traffic.
 * So capture is not a switch. What may be captured is DERIVED FROM THE RULE, and a rule earns each
 * permission by naming what it reads:
 *
 * - A rule naming a parameter (`post.title`, `cookie.session`, `server.HTTP_AUTHORIZATION`) permits that
 *   parameter's value. The rule was written to inspect it, so its value is what the finding is about.
 * - A prefix (`post.field_*`) permits the values of keys that match, and no others — bounded by a count,
 *   because a prefix can match an unbounded number of keys and "a rule that reads a prefix" must not
 *   become "a rule that reads the whole body".
 * - `raw` and `all` permit NOTHING. They read the entire request, so deriving a permission from them
 *   would derive permission for everything — the broadest rules granting the broadest capture, which is
 *   exactly backwards.
 * - Raw request bytes are capturable only when the rule carries an explicit, reviewed `capture` opt-in.
 *   That is a decision someone makes about one rule, not a consequence of how the rule happens to match.
 *
 * Two properties matter as much as the policy itself.
 *
 * **It is the rule's, not the clause's.** The engine reports which RULE matched, not which of its
 * conditions did, so a plan covers the union of everything the rule reads. Narrowing to the matching
 * clause would mean changing evaluation to report one, and a plan that claimed clause-level precision it
 * did not have would be worse than one that says what it is.
 *
 * **It is fixed to a revision.** The plan is derived from the immutable rule revision and cached against
 * it, and the event records which plan governed it. A rule that changes gets a new revision and a new
 * plan, so a captured value can always be traced to the policy that permitted it — rather than to
 * whatever the rule says by the time anyone looks.
 */

/** Sources whose named values a rule may capture by naming them. */
const CAPTURABLE = new Set(['get', 'post', 'request', 'cookie', 'server', 'files', 'egress']);

/**
 * `response.*` is deliberately absent.
 *
 * Those read what the application is about to send, so they are the app's own output rather than
 * something a client submitted — the phase that inspects them exists to REDACT secrets, and a channel
 * that captured them would collect the very values the redaction is there to stop leaving.
 */
const NEVER_CAPTURABLE = new Set(['response']);

/** Bounds every plan carries, so a permission cannot become an unbounded one. */
export const CAPTURE_LIMITS = {
  /** Values in one event, across every permission it holds. */
  values: 10,
  /** Characters of any single captured value. */
  valueChars: 512,
  /** Keys one prefix permission may match. */
  prefixKeys: 5,
};

/** The parameters a rule reads, as the union over its conditions and nested groups. */
function parametersOf(rule) {
  const out = new Set();
  const walk = (conditions, depth) => {
    if (!Array.isArray(conditions) || depth > 20) return;
    for (const condition of conditions) {
      if (!condition || typeof condition !== 'object') continue;
      if (typeof condition.parameter === 'string' && condition.parameter !== 'rules') {
        out.add(condition.parameter);
      }
      if (Array.isArray(condition.rules)) walk(condition.rules, depth + 1);
    }
  };
  walk(rule?.rule_v2, 0);

  return [...out];
}

/**
 * The raw-body opt-in a rule carries, if it carries a valid one.
 *
 * Only ever a prefix of the body, never the whole of it, and only up to a reviewed number of characters.
 * A rule asking for more than the cap gets the cap rather than what it asked for: the opt-in says a
 * reviewer agreed raw bytes are needed here, not that this rule sets its own bounds.
 */
function rawOptIn(rule) {
  const requested = Number(rule?.capture?.raw_chars);
  if (!Number.isFinite(requested) || requested <= 0) return null;

  return { chars: Math.min(Math.floor(requested), CAPTURE_LIMITS.valueChars) };
}

/**
 * Derive what may be captured for a rule.
 *
 * Pure, and total: an unreadable rule yields a plan that permits nothing, because the failure to
 * understand a rule must never be the reason something gets captured.
 */
export function derivePlan(rule) {
  /** @type {Set<string>} */
  const named = new Set();
  /** @type {Set<string>} */
  const prefixes = new Set();

  for (const parameter of parametersOf(rule)) {
    // `raw` and `all` read everything, so they permit nothing.
    const dot = parameter.indexOf('.');
    if (dot === -1) continue;

    const source = parameter.slice(0, dot);
    const key = parameter.slice(dot + 1);
    if (!CAPTURABLE.has(source) || NEVER_CAPTURABLE.has(source) || key === '') continue;

    if (key.endsWith('*')) {
      const prefix = key.slice(0, -1);
      // A bare `source.*` is `all` wearing a different hat: it names nothing, so it permits nothing.
      if (prefix !== '') prefixes.add(`${source}.${prefix}`);
      continue;
    }
    named.add(`${source}.${key}`);
  }

  return {
    named: [...named].sort(),
    prefixes: [...prefixes].sort(),
    raw: rawOptIn(rule),
    limits: { ...CAPTURE_LIMITS },
  };
}

/** Whether a plan permits anything at all — the common case is that it does not. */
export function permitsAnything(plan) {
  return plan.named.length > 0 || plan.prefixes.length > 0 || plan.raw !== null;
}

/**
 * A short, stable reference for a plan, recorded on every event the plan governed.
 *
 * Content-derived rather than a counter, so the same policy has the same reference across processes and
 * releases, and two events carrying the same reference were really governed by the same permissions. A
 * reader can then ask what a capture was allowed to include without needing the rule in front of them.
 */
export function planReference(plan) {
  // Sorted here as well as in `derivePlan`: this is the value that ties a captured value to the policy
  // that permitted it, so the tie must not rest on an ordering established somewhere else.
  const canonical = JSON.stringify([
    [...plan.named].sort(),
    [...plan.prefixes].sort(),
    plan.raw?.chars ?? 0,
  ]);
  // FNV-1a: short, dependency-free and stable. Not a security boundary — nothing is authenticated by
  // this, it only has to name a plan consistently.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return `cp1-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Plans for the rules of one bundle, derived once and reused.
 *
 * Keyed by the rule's immutable revision where the bundle carried one, so a rule that changes gets a new
 * plan rather than an old one that no longer describes it. A rule with no revision is keyed by its own
 * derived reference, which is the same thing computed the long way.
 */
export function createPlanCache() {
  const byKey = new Map();

  return {
    for(rule) {
      const revision = rule?.rule_revision ?? rule?.revision ?? null;
      const key = typeof revision === 'string' && revision !== '' ? `r:${revision}` : null;
      if (key !== null) {
        const hit = byKey.get(key);
        if (hit) return hit;
      }

      const plan = derivePlan(rule);
      const entry = { plan, reference: planReference(plan) };
      if (key !== null) byKey.set(key, entry);

      return entry;
    },
    get size() {
      return byKey.size;
    },
  };
}
