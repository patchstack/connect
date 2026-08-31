/**
 * Whether this guard reports security events, and if not, why not.
 *
 * Detection reporting is retained security-event evidence for sites the platform manages, not
 * lightweight telemetry. So it turns on for an enrolled site with managed rules, and stays off
 * everywhere else — a local install, a guard running its caller's own bundle, a site with no
 * credential.
 *
 * The state is a single value with a reason built into it, because "no events arrived" has several
 * causes that look identical from the platform: nothing matched, reporting was switched off, the site
 * was never enrolled, or delivery is broken.
 *
 * Most of these travel: the state is declared on the rules fetch the guard already makes, so the platform
 * learns it without an extra request and without waiting for a rule to fire. Two do not, and cannot:
 *
 *   `not-enrolled`               makes no site-addressed request at all, so there is nothing to carry it
 *   `unavailable-no-credential`  cannot produce an authenticated request, and the declaration is withheld
 *                                from an unauthenticated one because a claim about a site carries no
 *                                weight without a verified token
 *
 * Both remain useful locally — `protect --check` reports them, and they are why a guard is silent. But the
 * platform cannot infer them from this header, so server-side absence has to be modelled on its own terms
 * (last seen, and how long ago) rather than treated as a state the guard reported.
 */

/**
 * Reporting states, and what each licenses.
 *
 * Only `on` reports. Every other value is a reason, and each is distinguishable at the platform so the
 * dashboard can say which one it is.
 */
export const REPORTING_STATES = Object.freeze([
  /** Enrolled, managed rules, credential present, not opted out. Events are sent. */
  'on',
  /** `PATCHSTACK_REPORT_DETECTIONS=0`. An explicit, per-deployment opt-out. */
  'disabled-by-config',
  /** `PATCHSTACK_TELEMETRY=0`. The broader switch, which covers this along with everything else. */
  'disabled-by-telemetry-opt-out',
  /** No site identity: a local or unenrolled install. Nothing to report against. */
  'not-enrolled',
  /**
   * A site identity, but the rules running are not the platform's — the caller's own bundle, or none.
   * There is no managed rule document to attribute a detection to, so a report would name a rule id the
   * platform never issued.
   */
  'no-managed-rules',
  /** Enrolled with managed rules, but no credential resolved, so a report would be refused. */
  'unavailable-no-credential',
]);

/**
 * Read an environment opt-out.
 *
 * Absent and empty both mean "not set" rather than "off": an unset variable is the default state, and a
 * deployment that exports an empty value has not made a choice.
 */
function optedOut(value) {
  if (value === undefined || value === null || value === '') return false;

  return /^(0|false|off|no)$/i.test(String(value));
}

/**
 * Decide the reporting state.
 *
 * Pure, and separate from the runtime, so every combination can be enumerated in a test rather than
 * reached by constructing a guard. The order of the checks is the meaning: an explicit opt-out outranks
 * everything, because a deployment that switched reporting off should be told that is why — not that it
 * lacks a credential it never needed.
 *
 * @param {{
 *   siteUuid?: unknown,
 *   ruleOrigin?: 'api'|'cache'|'bundled'|'empty',
 *   hasCredential?: boolean,
 *   configOptOut?: boolean,
 *   env?: Record<string, string | undefined>,
 * }} input
 * @returns {{ state: typeof REPORTING_STATES[number], reports: boolean }}
 */
export function reportingState(input) {
  const env = input.env ?? (typeof process !== 'undefined' ? process.env : undefined) ?? {};

  // Explicit opt-outs first, and reported distinctly. Collapsing them would tell an operator who set
  // one variable to check the other.
  //
  // The programmatic flag is an opt-out ONLY. `reportDetections: false` switches reporting off;
  // `true` cannot switch it on, because whether a site is managed is the platform's answer and not a
  // caller's to assert. A guard that could self-declare managed status would report against rule ids
  // the platform never issued.
  if (input.configOptOut === true) return { state: 'disabled-by-config', reports: false };
  if (optedOut(env.PATCHSTACK_REPORT_DETECTIONS)) return { state: 'disabled-by-config', reports: false };
  if (optedOut(env.PATCHSTACK_TELEMETRY)) return { state: 'disabled-by-telemetry-opt-out', reports: false };

  const siteUuid = input.siteUuid;
  if (typeof siteUuid !== 'string' || siteUuid === '') return { state: 'not-enrolled', reports: false };

  // The credential is checked BEFORE the managed-rules question, because a missing credential is what
  // causes managed rules to be missing: the rules fetch is refused, resolution falls back to the
  // caller's bundle or to nothing, and the origin is then `bundled` or `empty`. Asking about the origin
  // first would report `no-managed-rules` for a site whose real and fixable problem is the credential,
  // sending an operator to look for an enrolment that already exists.
  if (input.hasCredential !== true) return { state: 'unavailable-no-credential', reports: false };

  // `cache` counts as managed: the rules came from the platform, just not on this call. Excluding it
  // would silence reporting for exactly the sites whose delivery is degraded — the ones whose evidence
  // is most worth having.
  const managed = input.ruleOrigin === 'api' || input.ruleOrigin === 'cache';
  if (!managed) return { state: 'no-managed-rules', reports: false };

  return { state: 'on', reports: true };
}

/**
 * A human-readable reason for `protect --check` and startup diagnostics.
 *
 * Every non-reporting state gets a sentence, because the state name alone is a label and an operator
 * asking "why is nothing arriving" needs the answer, not the category.
 */
export function explainReportingState(state) {
  switch (state) {
    case 'on':
      return 'Security events are reported to Patchstack for this site.';
    case 'disabled-by-config':
      return 'Reporting is off because PATCHSTACK_REPORT_DETECTIONS is set to a false value.';
    case 'disabled-by-telemetry-opt-out':
      return 'Reporting is off because PATCHSTACK_TELEMETRY is set to a false value, which covers all telemetry.';
    case 'not-enrolled':
      return 'Reporting is off because this install has no site identity — it is not enrolled in Patchstack-managed mitigation.';
    case 'no-managed-rules':
      return 'Reporting is off because the rules in force did not come from Patchstack, so a detection could not be attributed to a managed rule.';
    case 'unavailable-no-credential':
      return 'Reporting is unavailable because no API credential resolved, so a report would be refused.';
    default:
      return `Unrecognised reporting state: ${String(state)}.`;
  }
}
