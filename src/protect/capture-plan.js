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

import {
  CAPTURE_RAW_CHARS_MAX,
  SOURCES,
  captureProblem,
  parameterProblem,
} from './rules/contract.js';
import { enforceableRuleProblem } from './rules/validate.js';

/**
 * `response.*` is the one keyed source a rule can never capture from.
 *
 * Those read what the application is about to send, so they are the app's own output rather than
 * something a client submitted — the phase that inspects them exists to REDACT secrets, and a channel
 * that captured them would collect the very values the redaction is there to stop leaving.
 */
const NEVER_CAPTURABLE = new Set(['response']);

/**
 * Bounds every plan carries, so a permission cannot become an unbounded one.
 *
 * Named for what they count. `capturedValues` is the budget for named and prefix captures together; raw
 * is NOT drawn from it, because raw is separately opted into and separately bounded by its own
 * `raw.chars`, and making it consume a value slot would have a raw opt-in silently reduce the named
 * evidence a reviewer needs. `prefixValues` counts resolved VALUES rather than matched keys: the
 * resolver answers a wildcard with values, so keys are not available to count and claiming otherwise
 * would describe a bound this cannot enforce.
 */
export const CAPTURE_LIMITS = Object.freeze({
  /** Named and prefix values in one event, together. Raw has its own allowance. */
  capturedValues: 10,
  /** Characters of any single captured value. */
  valueChars: 512,
  /** Resolved values one prefix permission may contribute. */
  prefixValues: 5,
});

/** The parameters a rule reads, as the union over its conditions and nested groups. */
function parametersOf(rule) {
  const out = new Set();
  // A condition may name one parameter or a list of them, and the engine reads every member. A walker
  // that saw only the string form would derive an empty plan from a rule that reads a dozen fields.
  const add = (parameter) => {
    if (typeof parameter === 'string' && parameter !== 'rules') out.add(parameter);
  };
  const collect = (parameter) => {
    // One level, because the engine expands one level. A nested list resolves to nothing there, so
    // flattening it here would grant a permission for a parameter no match can read.
    if (Array.isArray(parameter)) {
      for (const member of parameter) add(member);

      return;
    }
    add(parameter);
  };
  const walk = (conditions, depth) => {
    if (!Array.isArray(conditions) || depth > 20) return;
    for (const condition of conditions) {
      if (!condition || typeof condition !== 'object') continue;
      collect(condition.parameter);
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
  // The rule's OWN property, validated by the contract. A `capture` reachable through a polluted
  // prototype belongs to no rule, and would grant raw capture to every rule at once; a value coerced
  // into a number — a string, a boolean, a one-element array — is not an opt-in anyone reviewed.
  if (!rule || typeof rule !== 'object' || !Object.hasOwn(rule, 'capture')) return null;

  const capture = rule.capture;
  // `captureProblem` reads an absent capture as "no opt-in", which is the default and not a problem — so
  // the shape is confirmed here before anything is read off it.
  if (capture === null || typeof capture !== 'object') return null;
  if (captureProblem(capture) !== null) return null;

  return { chars: Math.min(capture.raw_chars, CAPTURE_RAW_CHARS_MAX) };
}

/**
 * Derive what may be captured for a rule.
 *
 * Pure, and total: an unreadable rule yields a plan that permits nothing, because the failure to
 * understand a rule must never be the reason something gets captured.
 */
const NOTHING = Object.freeze({
  named: Object.freeze([]),
  prefixes: Object.freeze([]),
  raw: null,
  limits: CAPTURE_LIMITS,
});

export function derivePlan(rule) {
  /** @type {Set<string>} */
  const named = new Set();
  /** @type {Set<string>} */
  const prefixes = new Set();

  // A permission exists to explain a detection, and a rule the guard would not run produces none. So the
  // question is whether this rule is one the validator accepts — the same judgement that decides whether
  // it protects anything — rather than whether its parameters happen to be spelled correctly. A rule with
  // a parameter and no match is refused there and authorises nothing here, and a rule matching on the
  // whole request carries no parameter at all yet is perfectly able to fire.
  //
  // Capture validity is deliberately not part of that judgement: it governs collection, never protection.
  if (enforceableRuleProblem(rule) !== null) return NOTHING;

  // The contract decides what is a parameter at all. Judging that here would be a second grammar to keep
  // in step with the engine's, and the two drifting apart means authorising capture of something no rule
  // can even read — `server.HTTP_*` and `egress.anything` are refused there, not here.
  const parameters = parametersOf(rule).filter((parameter) => parameterProblem(parameter) === null);

  for (const parameter of parameters) {
    const dot = parameter.indexOf('.');
    // A keyless source reads the whole request, so it names nothing to capture.
    if (dot === -1) continue;

    const source = parameter.slice(0, dot);
    const key = parameter.slice(dot + 1);
    if (SOURCES[source]?.keyed !== true || NEVER_CAPTURABLE.has(source)) continue;

    if (key.endsWith('*')) {
      const prefix = key.slice(0, -1);
      // A bare `source.*` is `all` wearing a different hat: it names nothing, so it permits nothing.
      if (prefix !== '') prefixes.add(`${source}.${prefix}`);
      continue;
    }
    named.add(`${source}.${key}`);
  }

  const raw = rawOptIn(rule);

  // Frozen: the reference below identifies a set of permissions, so a plan that could be edited after
  // its reference was computed would leave the reference naming permissions that no longer apply.
  return Object.freeze({
    named: Object.freeze([...named].sort()),
    prefixes: Object.freeze([...prefixes].sort()),
    raw: raw === null ? null : Object.freeze(raw),
    limits: CAPTURE_LIMITS,
  });
}

/** Whether a plan permits anything at all — the common case is that it does not. */
export function permitsAnything(plan) {
  return plan.named.length > 0 || plan.prefixes.length > 0 || plan.raw !== null;
}

/**
 * A stable reference for a plan, recorded on every event the plan governed.
 *
 * Content-derived rather than a counter, so the same permissions have the same reference across
 * processes and releases, and two events carrying one reference really were governed by the same
 * permissions. A reader can then ask what a capture was allowed to include without the rule in front of
 * them.
 *
 * It covers the WHOLE plan, limits included. Two plans naming the same parameters but allowing 512 and
 * 4096 characters are different permissions, and a reference that could not tell them apart would be
 * making exactly the claim it exists to support.
 *
 * Not a security boundary. Nothing is authenticated by it, and it is not built to resist anyone trying
 * to collide it: four FNV-1a lanes with distinct bases give 128 output bits from a non-cryptographic
 * function, chosen because it needs no dependency and no runtime API an edge target may lack. What it is
 * built for is accidental collision between the small number of plans a bundle produces, which that is
 * comfortably wide enough for.
 *
 * The algorithm and the canonical form are part of what the prefix means. Changing either changes what
 * every existing reference refers to, so it takes a new prefix rather than a new implementation under the
 * old one — a pinned vector in the tests is what makes that a decision instead of an accident. Renaming a
 * limit changes the canonical form, which is why this reads `cp2-`.
 */
const LANES = Object.freeze([0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]);

export function planReference(plan) {
  // Sorted here as well as in `derivePlan`: this is the value that ties a captured value to the policy
  // that permitted it, so the tie must not rest on an ordering established somewhere else.
  const limits = plan?.limits ?? {};
  const canonical = JSON.stringify([
    [...(plan?.named ?? [])].sort(),
    [...(plan?.prefixes ?? [])].sort(),
    plan?.raw?.chars ?? 0,
    Object.entries(limits)
      .map(([key, value]) => [key, value])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);

  const digest = LANES.map((base) => {
    let hash = base >>> 0;
    for (let i = 0; i < canonical.length; i++) {
      hash ^= canonical.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash.toString(16).padStart(8, '0');
  }).join('');

  return `cp2-${digest}`;
}

/**
 * Plans for the rules in play, derived once and reused.
 *
 * Keyed on the rule OBJECT, not on a revision string. A revision identifies a version of one rule, not a
 * rule — two rules can carry the same revision, and a cache keyed on that alone would answer for the
 * second with the first's permissions, capturing a field the second rule never authorised. Object
 * identity cannot make that mistake, and a bundle that is re-fetched brings new objects, so a changed
 * rule is derived again rather than answered from a stale entry.
 *
 * A `WeakMap` also means an entry lives exactly as long as the rule it describes.
 */
export function createPlanCache() {
  const byRule = new WeakMap();
  let derivations = 0;

  return {
    for(rule) {
      if (rule === null || typeof rule !== 'object') {
        // Nothing to key on, and nothing to cache: derive an empty plan and let the caller carry on.
        const plan = derivePlan(rule);

        derivations += 1;

        return Object.freeze({ plan, reference: planReference(plan) });
      }

      const hit = byRule.get(rule);
      if (hit) return hit;

      const plan = derivePlan(rule);
      derivations += 1;
      // Frozen with the plan, so the reference and the permissions it names cannot come apart.
      const entry = Object.freeze({ plan, reference: planReference(plan) });
      byRule.set(rule, entry);

      return entry;
    },
    /** How many plans have been derived — the observable difference between a hit and a miss. */
    get derivations() {
      return derivations;
    },
  };
}

/**
 * The evidence a plan permits, read from one request.
 *
 * Reads only what the plan names, in the plan's order, and through THE resolver the match was decided by
 * — handed in, never built here. Building one would read the request a second time, and a request can
 * answer differently twice: a getter, a stream, anything lazy. Evidence that disagrees with the match it
 * belongs to is worse than no evidence, so the only reading available here is the one that already
 * happened.
 *
 * **It is the resolved value, which is neither the bytes as sent nor the string the matcher compared.**
 * Three forms of a parameter exist. The engine normalises a request first — URL-decoding, HTML-entity
 * decoding, stripping comments and control characters, collapsing whitespace — and then applies whatever
 * mutations a rule's own condition asks for. This records the middle one, because that is what the
 * resolver answers with and reading either of the others would be a second interpretation of the request.
 *
 * So a percent-encoded payload arrives here decoded, while a rule's `base64_decode` is not applied and its
 * subject arrives still encoded. Reproducing the matched subject would need condition-level evidence: the
 * engine reports which RULE fired, not which condition, and this plan deliberately does not model one.
 *
 * Bounds apply, and each reports what it left out:
 *
 * - a total across named and prefix values, so one detection cannot carry an unbounded amount of an
 *   application's data
 * - a length per value, so one field cannot
 * - a number of resolved values per prefix, so a prefix permission stays narrower than the body it sits in
 *
 * Raw is bounded separately by its own opt-in and does not draw on the value total.
 *
 * Absence and failure are different answers, and the result distinguishes them. A field that was not
 * there, a value refused for its type, a parameter whose read threw, and a request nothing could be read
 * from would otherwise all arrive as "no evidence" — letting a reviewer read incomplete evidence as
 * complete. None of it is content: they are counts of what did not make it, and why.
 *
 * `unavailable` means no read completed at all: there was no resolver to read with, or every permitted
 * read threw. It is the difference between "this request carried none of what the rule reads" and "this
 * request could not be read", which are opposite conclusions from the same empty list.
 */
export function captureValues(plan, resolver) {
  const nothing = { values: [], omitted: 0, unsupported: 0, failed: 0, unavailable: false, raw: null };
  if (!plan || !permitsAnything(plan)) return nothing;
  if (!resolver || typeof resolver.resolve !== 'function') return { ...nothing, unavailable: true };

  const limits = plan.limits ?? CAPTURE_LIMITS;
  const values = [];
  let omitted = 0;
  let unsupported = 0;
  let failed = 0;
  let attempted = 0;

  const read = (parameter) => {
    attempted += 1;
    try {
      const resolved = resolver.resolve(parameter);

      return Array.isArray(resolved) ? resolved : [];
    } catch {
      // Fail-open for the application: a capture that cannot be taken is not taken. Counted, so that
      // "nothing was captured" is not mistaken for "there was nothing to capture".
      failed += 1;

      return null;
    }
  };

  /**
   * What one resolved value is, before anything is decided about room for it.
   *
   * Classified here rather than inside the recording step, so that "refused for its type" and "left out
   * by a bound" cannot swap places depending on where a value happens to fall in a request.
   */
  const classify = (value) => {
    const text = asText(value);
    if (text === null) {
      unsupported += 1;

      return null;
    }

    return text;
  };

  /** @returns {boolean} whether there was room for it */
  const record = (parameter, text) => {
    if (values.length >= limits.capturedValues) {
      omitted += 1;

      return false;
    }

    const capped = text.length > limits.valueChars;
    values.push({
      parameter,
      value: capped ? text.slice(0, limits.valueChars) : text,
      ...(capped ? { truncated: true } : {}),
    });

    return true;
  };

  for (const parameter of plan.named) {
    // Every resolved value is offered, not just up to the first refusal: a parameter can resolve to many
    // values, and stopping at the first excess would report one omission where there were several.
    for (const value of read(parameter) ?? []) {
      const text = classify(value);
      if (text !== null) record(parameter, text);
    }
  }

  for (const prefix of plan.prefixes) {
    // The pattern the rule wrote, put back together: the plan holds the prefix, the resolver reads the
    // wildcard. Labelled by the pattern rather than by the key it matched, because the resolver answers
    // with values and inventing a key here would mean enumerating the request a second way.
    const pattern = `${prefix}*`;
    let taken = 0;
    for (const value of read(pattern) ?? []) {
      // Classified before the prefix bound is consulted, for the same reason as above: what a value IS
      // does not depend on how many came before it.
      const text = classify(value);
      if (text === null) continue;
      if (taken >= limits.prefixValues) {
        omitted += 1;
        continue;
      }
      if (record(pattern, text)) taken += 1;
    }
  }

  let raw = null;
  if (plan.raw !== null) {
    const text = asText((read('raw') ?? [])[0]);
    if (text !== null) {
      const capped = text.length > plan.raw.chars;
      raw = { value: capped ? text.slice(0, plan.raw.chars) : text, ...(capped ? { truncated: true } : {}) };
    }
  }

  // Nothing was readable, as opposed to nothing being there to read.
  const unavailable = attempted > 0 && failed === attempted;

  return { values, omitted, unsupported, failed, unavailable, raw };
}

/**
 * A value as text, or null when its type is not one a request carries as a value.
 *
 * An empty string is text. A rule can be written so that its finding IS that a parameter is empty, and
 * collapsing that into absence would erase the evidence for exactly those rules — an absent field
 * resolves to no value at all, which is already a different answer.
 *
 * An object is refused rather than serialised, because serialising it would reach past the field the plan
 * named into whatever it contains: a permission for `post.profile` is not a permission for everything
 * under it.
 */
function asText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);

  return null;
}
